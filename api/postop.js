import fetch from "node-fetch";

const TELEGRAM_API = "https://api.telegram.org";
const SENDGRID_API = "https://api.sendgrid.com/v3/mail/send";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const auth = req.headers["authorization"] || "";
    const SECRET = process.env.SECRET_TOKEN || "";
    if (!auth || auth !== `Bearer ${SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body || {};
    const patient = payload.patient || {};
    const convo = payload.conversation || {};
    const postop = payload.postop || {};
    const message_text = (postop.symptoms_text || payload.message_text || "").toLowerCase();

    let score = 0;
    if (/chảy máu|bleeding/.test(message_text)) score += 40;
    if (/khó thở|shortness of breath|dyspnea/.test(message_text)) score += 60;
    if (/sốt|fever/.test(message_text)) score += 25;
    if (/mủ|purulence|pus/.test(message_text)) score += 30;
    if (postop.temperature_c && Number(postop.temperature_c) >= 38) score += 25;
    if (postop.bleeding === "yes") score += 40;
    if (postop.breathing_difficulty === "yes") score += 60;

    let triage_level = "routine";
    if (score >= 70) triage_level = "emergency";
    else if (score >= 50) triage_level = "urgent";

    let bot_response = "";
    if (triage_level === "emergency") {
      bot_response = `Dạ bác ơi, theo mô tả hiện có dấu hiệu *khẩn cấp (emergency)*. Vui lòng gọi cấp cứu hoặc đến phòng khám/khối cấp cứu ngay. Chúng tôi đã thông báo cho bác sĩ trực.`;
    } else if (triage_level === "urgent") {
      bot_response = `Dạ có dấu hiệu cần khám sớm (urgent). Vui lòng đặt lịch trong 24 giờ hoặc chờ bác sĩ liên hệ. Hướng dẫn tạm thời: chườm lạnh, nghỉ ngơi.`;
    } else {
      bot_response = `Dạ ổn (routine). Hiện chỉ cần chăm sóc tại nhà: rửa tay trước khi chạm, súc miệng nhẹ bằng nước muối 0.9% và theo dõi. Nếu sốt >38°C, chảy máu nhiều hoặc đau tăng thì báo ngay.`;
    }

    const alert_sent = (triage_level === "emergency" || triage_level === "urgent");
    let alert_id = null;

    if (alert_sent) {
      alert_id = `A${Date.now()}`;
      const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
      const doctorChat = process.env.DOCTOR_CHAT_ID;

      if (telegramToken && doctorChat) {
        const textMsg = `ALERT ${triage_level.toUpperCase()} - ${patient.patient_id || "unknown"}\nScore:${score}\nMsg:${(postop.symptoms_text || "").slice(0,200)}`;
        await fetch(`${TELEGRAM_API}/bot${telegramToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: doctorChat, text: textMsg })
        });
      }
    }

    return res.status(200).json({
      triage_level,
      triage_code: score,
      bot_response,
      actions: { alert_sent, alert_id }
    });

  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).json({ error: "Internal error" });
  }
}
