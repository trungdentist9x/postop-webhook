// api/postop.js
// Vercel serverless function (Node 24, "type":"module")
export default async function handler(req, res) {
  try {
    // only POST
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    // Basic auth check - required
    const auth = (req.headers["authorization"] || "").trim();
    const envSecret = process.env.SECRET_TOKEN || "";
    if (!envSecret) {
      console.error("SECRET_TOKEN not set in environment");
      return res.status(500).json({ error: "server_config_missing" });
    }
    if (auth !== `Bearer ${envSecret}`) {
      // unauthorized
      console.warn("Unauthorized access attempt. Provided Authorization header:", auth ? auth.slice(0,40) + "..." : "(empty)");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // parse body
    const payload = req.body || {};
    // support both JSON body and raw text
    const patient = payload.patient || {};
    const convo = payload.conversation || {};
    const postop = payload.postop || {};

    const rawText = String(postop.symptoms_text || payload.message_text || "").toLowerCase();

    // Triage scoring rules (simple, extensible)
    let score = 0;

    // Keywords / regex checks
    const hasBleeding = /chảy máu|bleeding|máu/i.test(rawText) || String(postop.bleeding || "").toLowerCase() === "yes";
    const hasDyspnea = /khó thở|shortness of breath|dyspnea|thở gấp/i.test(rawText);
    const hasFever = /sốt|fever/i.test(rawText) || (postop.temperature_c && Number(postop.temperature_c) >= 38);
    const hasSeverePain = /đau nhiều|severe pain|intense pain/i.test(rawText);
    const hasPurulence = /mủ|pus|purulent|chảy mủ/i.test(rawText);
    const hasSwelling = /sưng|swelling/i.test(rawText);
    const hasNumbness = /tê|numb/i.test(rawText);

    if (hasBleeding) score += 50;
    if (hasDyspnea) score += 80;
    if (hasFever) score += 25;
    if (hasSeverePain) score += 30;
    if (hasPurulence) score += 30;
    if (hasSwelling) score += 15;
    if (hasNumbness) score += 20;

    // numeric signals override/augment
    if (postop.temperature_c && Number(postop.temperature_c) >= 39) score += 25;
    if (postop.bleeding_amount && String(postop.bleeding_amount).match(/\b(heavy|many|lots|nhiều|rất nhiều)\b/i)) score += 30;

    // Normalize score (cap)
    if (score > 100) score = 100;

    // Map to triage level
    let triage_level = "routine";
    if (score >= 80 || hasDyspnea) {
      triage_level = "urgent"; // need immediate contact / emergency
    } else if (score >= 50) {
      triage_level = "early_review"; // see within hours
    } else if (score >= 25) {
      triage_level = "routine_review"; // routine follow-up / advice
    }

    // Compose bot_response (short, actionable)
    let bot_response = "";
    if (triage_level === "urgent") {
      bot_response = "Có dấu hiệu cần xử trí gấp (ví dụ: khó thở, chảy máu nhiều hoặc sốt cao). Vui lòng liên hệ bác sĩ cấp cứu/hẹn ngay hoặc đến cơ sở gần nhất. Nếu khó thở hoặc chảy máu không cầm, gọi cấp cứu.";
    } else if (triage_level === "early_review") {
      bot_response = "Tình trạng có dấu hiệu cần khám sớm trong vài giờ. Vui lòng gửi ảnh (nếu có) và liên hệ phòng khám để được tư vấn (gọi hotline hoặc chat).";
    } else if (triage_level === "routine_review") {
      bot_response = "Triệu chứng cần theo dõi. Hướng dẫn: giữ vệ sinh vùng phẫu thuật, chườm lạnh/vệ sinh nhẹ, uống thuốc theo đơn. Nếu triệu chứng nặng lên (tăng đau, sốt, chảy mủ), liên hệ lại.";
    } else {
      bot_response = "Không thấy dấu hiệu cấp tính; tiếp tục theo dõi theo hướng dẫn hậu phẫu. Nếu có thay đổi xấu, thông báo lại cho bác sĩ.";
    }

    // Response object
    const response = {
      triage_score: score,
      triage_code: Math.round(score), // simple code
      triage_level,
      bot_response,
      received: {
        patient,
        conversation: convo,
        postop
      }
    };

    // Optional: send Telegram / Email alerts for urgent cases
    try {
      if (triage_level === "urgent") {
        // Telegram
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.DOCTOR_CHAT_ID) {
          const tgUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
          const text = `ALERT - POSTOP triage: patient=${patient.patient_id || patient.name || "unknown"} level=${triage_level} score=${score}\n${bot_response}`;
          await fetch(tgUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: process.env.DOCTOR_CHAT_ID,
              text,
              disable_notification: false
            })
          }).catch(e => console.warn("Telegram send failed:", e && e.message));
        }

        // SendGrid-like email via https://api.sendgrid.com/v3/mail/send (if configured)
        if (process.env.SENDGRID_API_KEY && process.env.DOCTOR_EMAIL && process.env.EMAIL_FROM) {
          const mailUrl = "https://api.sendgrid.com/v3/mail/send";
          const emailBody = {
            personalizations: [{ to: [{ email: process.env.DOCTOR_EMAIL }] }],
            from: { email: process.env.EMAIL_FROM },
            subject: `POSTOP ALERT: ${patient.patient_id || patient.name || ""} - ${triage_level}`,
            content: [{ type: "text/plain", value: `${bot_response}\n\nData: ${JSON.stringify({ patient, postop }, null, 2)}` }]
          };
          await fetch(mailUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.SENDGRID_API_KEY}` },
            body: JSON.stringify(emailBody)
          }).catch(e => console.warn("SendGrid send failed:", e && e.message));
        }
      }
    } catch (e) {
      console.warn("Alert sending error:", e && e.message);
    }

    // Return triage result
    return res.status(200).json(response);

  } catch (err) {
    console.error("ERR_HANDLER:", err);
    return res.status(500).json({ error: "server_error", message: String(err && err.message) });
  }
}
