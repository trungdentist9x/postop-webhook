// api/postop.js – Webhook triage hậu phẫu (Node 18+ / Vercel)

// Telegram & SendGrid endpoints
const TELEGRAM_API = "https://api.telegram.org";
const SENDGRID_API = "https://api.sendgrid.com/v3/mail/send";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).send("Method Not Allowed");

    // Authentication
    const auth = req.headers["authorization"] || "";
    const SECRET = process.env.SECRET_TOKEN || "";
    if (!auth || auth !== `Bearer ${SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Extract payload
    const payload = req.body || {};
    const patient = payload.patient || {};
    const convo = payload.conversation || {};
    const postop = payload.postop || {};
    const msg = (postop.symptoms_text || payload.message_text || "").toLowerCase();

    // Triage scoring rules
    let score = 0;
    if (/chảy máu|bleeding/.test(msg)) score += 40;
    if (/khó thở|shortness of breath|dyspnea/.test(msg)) score += 60;
    if (/sốt|fever/.test(msg)) score += 25;
    if (/mủ|pus|purulence/.test(msg)) score += 30;

    if (postop.temperature_c && Number(postop.temperature_c) >= 38) score += 25;
    if (postop.bleeding === "yes") score += 40;
    if (postop.breathing_difficulty === "yes") score += 60;

    // Classification
    let triage_level = "routine";
    if (score >= 70) triage_level = "emergency";
    else if (score >= 50) triage_level = "urgent";

    // Response text for patient
    let bot_response = "";
    if (triage_level === "emergency") {
      bot_response = `Dạ bác ơi, dấu hiệu hiện tại thuộc nhóm *khẩn cấp (emergency)*. Bác vui lòng đến phòng khám hoặc khoa Cấp cứu ngay. Chúng tôi đã thông báo cho bác sĩ trực.`;
    } else if (triage_level === "urgent") {
      bot_response = `Dạ bác đang có dấu hiệu cần khám sớm (urgent). Vui lòng đến khám trong 24h hoặc chờ bác sĩ liên hệ. Tạm thời: chườm lạnh – hạn chế vận động – theo dõi chảy máu/sốt.`;
    } else {
      bot_response = `Hiện tại các dấu hiệu thuộc nhóm an toàn (routine). Bác theo dõi thêm, súc miệng nước muối nhạt và tránh va chạm vùng mổ. Nếu có chảy máu nhiều, sốt >38°C thì báo lại ngay.`;
    }

    // Alert rule
    const alert_sent = (triage_level === "urgent" || triage_level === "emergency");
    let alert_id = null;

    // Telegram alert
    if (alert_sent) {
      alert_id = `ALERT-${Date.now()}`;

      const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
      const doctorChat = process.env.DOCTOR_CHAT_ID;

      if (telegramToken && doctorChat) {
        const textMsg =
          `🔔 POST-OP ALERT\n` +
          `Level: ${triage_level.toUpperCase()}\n` +
          `Score: ${score}\n` +
          `Patient: ${patient.patient_id || "N/A"}\n` +
          `Message: ${(postop.symptoms_text || "").slice(0, 300)}\n` +
          `Time: ${convo.timestamp || new Date().toISOString()}`;

        try {
          await fetch(`${TELEGRAM_API}/bot${telegramToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: doctorChat,
              text: textMsg,
            }),
          });
        } catch (err) {
          console.error("Telegram error:", err);
        }
      }

      // SendGrid email alert
      const sgKey = process.env.SENDGRID_API_KEY;
      const emailFrom = process.env.EMAIL_FROM;
      const emailTo = process.env.DOCTOR_EMAIL;

      if (sgKey && emailFrom && emailTo) {
        const mail = {
          personalizations: [{ to: [{ email: emailTo }] }],
          from: { email: emailFrom },
          subject: `[ALERT ${triage_level.toUpperCase()}] Post-op triage`,
          content: [
            {
              type: "text/plain",
              value:
                `Patient: ${patient.name || ""} (${patient.patient_id || ""})\n` +
                `Score: ${score}\n` +
                `Symptoms: ${(postop.symptoms_text || "")}\n` +
                `Time: ${convo.timestamp || ""}`,
            },
          ],
        };
        try {
          await fetch(SENDGRID_API, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${sgKey}`,
            },
            body: JSON.stringify(mail),
          });
        } catch (err) {
          console.error("SendGrid error:", err);
        }
      }
    }

    // Return JSON to Chatbase
    return res.status(200).json({
      triage_level,
      triage_code: score,
      bot_response,
      actions: {
        alert_sent,
        alert_id,
      },
    });
  } catch (err) {
    console.error("Webhook Error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
