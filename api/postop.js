// api/postop.js
// Vercel serverless (Node 18+/24+) - ESM module
// Receives postoperative feedback (post-op), computes triage score, optional DB save, optional SendGrid alert.

import pg from 'pg';

const { Pool } = pg;

// Helper: get env with fallback
const env = (k, d='') => (process.env[k] || d).trim();

// Init DB pool only if DATABASE_URL provided
let pool = null;
if (env('DATABASE_URL')) {
  pool = new Pool({ connectionString: env('DATABASE_URL'), ssl: env('DB_SSL') ? { rejectUnauthorized: false } : false });
}

// Utility: safe JSON parse (not used but handy)
const safeJSON = (v) => {
  try { return JSON.parse(v); } catch (e) { return null; }
};

// Main handler
export default async function handler(req, res) {
  try {
    // Only POST allowed
    if (req.method !== 'POST') {
      res.status(405).json({ ok:false, error: 'Method Not Allowed' });
      return;
    }

    // Auth header check - accept "Bearer token" or raw token
    const authHeader = (req.headers['authorization'] || '').trim();
    const SECRET = env('SECRET_TOKEN');
    if (!SECRET) {
      console.error('Missing SECRET_TOKEN env');
      res.status(500).json({ ok:false, error: 'Server misconfiguration' });
      return;
    }
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader;
    if (!token || token !== SECRET) {
      res.status(401).json({ ok:false, error: 'Unauthorized' });
      return;
    }

    // Accept JSON body
    const data = req.body && Object.keys(req.body).length ? req.body : null;
    if (!data) {
      res.status(400).json({ ok:false, error: 'Empty body' });
      return;
    }

    // Extract structured fields (support multiple naming variants)
    const patient_id = data.patient_id || data.patientId || data.patient || null;
    const name = data.patient_name || data.name || data.patientName || '';
    const phone = data.phone || data.phone_number || data.mobile || '';
    const email = data.email || data.email_address || '';
    const service = data.service || data.procedure || '';
    const days_postop = Number(data.days_postop || data.daysPostop || data.days || 0);

    // Symptoms extraction (support flat or nested)
    const pain = Number(data.pain || data.pain_scale || data.symptoms?.pain_scale || 0); // 0..10
    const bleedingRaw = (data.bleeding || data.symptoms?.bleeding || '').toString().toLowerCase();
    const bleeding = (bleedingRaw === 'yes' || bleedingRaw === 'active' || bleedingRaw === 'true') ? 'active' : (bleedingRaw ? bleedingRaw : 'no');
    const temp = Number(data.temp || data.temperature || data.symptoms?.fever || 0); // Celsius
    const pusRaw = (data.pus || data.symptoms?.pus || '').toString().toLowerCase();
    const pus = (pusRaw === 'yes' || pusRaw === 'true') ? 'yes' : (pusRaw ? pusRaw : 'no');
    const notes = data.notes || data.symptoms?.notes || data.symptom_desc || data.description || '';
    const images = Array.isArray(data.images) ? data.images : (data.images ? [data.images] : (Array.isArray(data.consented_images) ? data.consented_images : []));

    // Compute triage score (explainable)
    // weights: pain 40%, bleeding 20%, fever 20%, pus 15%, days_postop small factor 5%
    const pain_norm = Math.min(Math.max(pain, 0), 10) / 10; // 0..1
    const bleeding_flag = (bleeding === 'active') ? 1 : 0;
    const fever_norm = temp ? Math.max(0, Math.min((temp - 36) / 4, 1)) : 0; // rough normalization
    const pus_flag = (pus === 'yes') ? 1 : 0;
    const days_factor = Math.min(Math.max(days_postop / 30, 0), 1); // 0..1 (older -> slightly higher risk if issues persist)

    let score = 0.4 * (pain_norm * 100) + 0.2 * (bleeding_flag * 100) + 0.2 * (fever_norm * 100) + 0.15 * (pus_flag * 100) + 0.05 * (days_factor * 100);
    score = Math.round(Math.min(Math.max(score, 0), 100));

    // Label rules + overrides (explainable)
    let label = score <= 30 ? 'low' : (score <= 60 ? 'moderate' : 'high');
    if (pus_flag || bleeding_flag || pain >= 8 || temp >= 38 || /khó thở|khó nuốt|difficulty breathing|swallow/i.test(notes)) {
      label = 'high';
    }

    // Build record object
    const record = {
      patient_id, name, phone, email, service, days_postop,
      symptoms: { pain, bleeding, temp, pus, notes, images },
      score, label, created_at: new Date().toISOString()
    };

    // Save to DB if configured (simple insert into postop_feedback JSONB)
    let dbId = null;
    if (pool) {
      try {
        const q = `INSERT INTO postop_feedback (patient_id, payload, score, label, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`;
        const vals = [patient_id || null, JSON.stringify(record), score, label, record.created_at];
        const r = await pool.query(q, vals);
        dbId = r.rows?.[0]?.id ?? null;
      } catch (e) {
        console.error('DB save error', e?.message || e);
        // do not fail request for DB error; just log
      }
    }

    // Create patient-facing message (Vietnamese + English label in parens)
    let patientMessage = '';
    if (label === 'low') {
      patientMessage = 'Cảm ơn. Theo mô tả là triệu chứng nhẹ (Low). Tiếp tục theo dõi, dùng thuốc giảm đau theo toa. Nếu nặng hơn trong 48 giờ, vui lòng upload ảnh hoặc liên hệ lại.';
    } else if (label === 'moderate') {
      patientMessage = 'Theo mô tả có triệu chứng cần khám sớm (Moderate). Vui lòng gửi ảnh vết mổ nếu có; bộ phận y tế sẽ liên hệ để sắp xếp lịch khám.';
    } else {
      patientMessage = 'CẢNH BÁO: Theo thông tin có dấu hiệu cần xử trí khẩn (High). Xin đến cơ sở y tế gần nhất hoặc gọi hotline. Bác sĩ đã nhận báo động. (English: Possible urgent issue — seek immediate care.)';
    }

    // Fire-and-forget alert if high
    if (label === 'high') {
      sendAlertEmail(record, dbId).catch(err => console.error('Alert email failed', err?.message || err));
    }

    // Return HTTP 200 with structured JSON (Chatbase action can parse this)
    res.status(200).json({ ok:true, recordId: dbId, score, label, patientMessage });

  } catch (err) {
    console.error('Unhandled handler error', err);
    res.status(500).json({ ok:false, error: err?.message || 'Internal error' });
  }
}

// ----- Helper: send email via SendGrid if configured -----
async function sendAlertEmail(record, dbId = null) {
  const SENDGRID_API_KEY = env('SENDGRID_API_KEY');
  const ALERT_EMAIL = env('ALERT_EMAIL');
  const EMAIL_FROM = env('EMAIL_FROM') || 'noreply@yourclinic.example';
  const DASHBOARD_URL = env('DASHBOARD_URL') || '';

  if (!SENDGRID_API_KEY || !ALERT_EMAIL) {
    console.warn('SendGrid or ALERT_EMAIL not set - skipping alert email');
    return;
  }

  const subject = `[ALERT] Postop HIGH - ${record.name || record.patient_id || 'Unknown'}`;
  const bodyText = [
    `Patient: ${record.name || 'N/A'} (${record.patient_id || 'N/A'})`,
    `Phone: ${record.phone || 'N/A'}  Email: ${record.email || 'N/A'}`,
    `Service: ${record.service || 'N/A'}  Days post-op: ${record.days_postop || 0}`,
    `Score: ${record.score}  Label: ${record.label}`,
    `Symptoms: ${JSON.stringify(record.symptoms)}`,
    dbId ? `Case link: ${DASHBOARD_URL.replace(/\/$/,'')}/cases/${dbId}` : `Dashboard: ${DASHBOARD_URL || 'N/A'}`,
    `Timestamp: ${record.created_at}`
  ].join('\n\n');

  const payload = {
    personalizations: [{ to: [{ email: ALERT_EMAIL }], subject }],
    from: { email: EMAIL_FROM },
    content: [{ type: 'text/plain', value: bodyText }]
  };

  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`SendGrid error ${resp.status}: ${txt}`);
  }
}
