import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  phoneCalls,
  voicemails,
  smsMessages,
  phoneNumbers,
  crmLeadsTable,
} from "@workspace/db/schema";
import {
  twilioService,
  generateVoiceResponse,
  generateVoicemailResponse,
} from "@workspace/integrations-twilio";

const router = Router();

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

// POST /api/pbx/webhooks/voice — inbound call handler
router.post("/webhooks/voice", async (req, res) => {
  res.setHeader("Content-Type", "text/xml");

  const body = req.body as Record<string, string>;
  const To = body["To"] ?? "";
  const From = body["From"] ?? "";
  const CallSid = body["CallSid"] ?? "";

  try {
    const [phoneNum] = await db
      .select()
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.tenantId, TENANT_ID), eq(phoneNumbers.phoneNumber, To)));

    const voicemailEnabled = phoneNum?.voicemailEnabled ?? true;
    const greeting =
      phoneNum?.voicemailGreeting ??
      "Thank you for calling Accelerated Experiences. We are unavailable right now. Please leave a message after the beep.";

    if (CallSid) {
      await db.insert(phoneCalls).values({
        tenantId: TENANT_ID,
        twilioCallSid: CallSid,
        direction: "inbound",
        fromNumber: From,
        toNumber: To,
        status: "ringing",
        startedAt: new Date(),
      }).onConflictDoNothing();
    }

    const twiml = voicemailEnabled
      ? generateVoicemailResponse(greeting)
      : generateVoiceResponse({ greeting: "Thank you for calling. Goodbye." });

    return res.send(twiml);
  } catch (_err) {
    const twiml = generateVoicemailResponse(
      "Thank you for calling Accelerated Experiences. Please leave a message after the beep."
    );
    return res.send(twiml);
  }
});

// POST /api/pbx/webhooks/call-status
router.post("/webhooks/call-status", async (req, res) => {
  const body = req.body as Record<string, string>;
  const CallSid = body["CallSid"] ?? "";
  const CallStatus = body["CallStatus"] ?? "";
  const CallDuration = body["CallDuration"];
  const RecordingUrl = body["RecordingUrl"];
  const RecordingSid = body["RecordingSid"];

  try {
    const updates: Partial<typeof phoneCalls.$inferInsert> = {
      status: CallStatus,
      duration: CallDuration ? parseInt(CallDuration, 10) : 0,
    };
    if (RecordingUrl) updates.recordingUrl = RecordingUrl;
    if (RecordingSid) updates.recordingSid = RecordingSid;
    if (CallStatus === "completed") updates.endedAt = new Date();
    if (CallStatus === "in-progress") updates.answeredAt = new Date();

    await db
      .update(phoneCalls)
      .set(updates)
      .where(eq(phoneCalls.twilioCallSid, CallSid));
  } catch (_err) {
  }

  return res.status(204).send();
});

// POST /api/pbx/webhooks/voicemail — voicemail recording callback
router.post("/webhooks/voicemail", async (req, res) => {
  res.setHeader("Content-Type", "text/xml");
  const body = req.body as Record<string, string>;
  const CallSid = body["CallSid"] ?? "";
  const RecordingUrl = body["RecordingUrl"];
  const RecordingSid = body["RecordingSid"];
  const RecordingDuration = body["RecordingDuration"];
  const From = body["From"] ?? "";
  const To = body["To"] ?? "";

  try {
    const [call] = await db
      .select({ id: phoneCalls.id })
      .from(phoneCalls)
      .where(eq(phoneCalls.twilioCallSid, CallSid));

    if (call && RecordingSid) {
      const [lead] = await db
        .select({ id: crmLeadsTable.id })
        .from(crmLeadsTable)
        .where(and(eq(crmLeadsTable.tenantId, TENANT_ID), eq(crmLeadsTable.phone, From)))
        .limit(1);

      await db.insert(voicemails).values({
        tenantId: TENANT_ID,
        callId: call.id,
        twilioRecordingSid: RecordingSid,
        fromNumber: From,
        toNumber: To,
        recordingUrl: RecordingUrl ?? "",
        duration: RecordingDuration ? parseInt(RecordingDuration, 10) : 0,
        transcriptionStatus: "pending",
        crmLeadId: lead?.id ?? null,
      }).onConflictDoNothing();
    }
  } catch (_err) {
  }

  return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Your message has been recorded. Goodbye.</Say></Response>`);
});

// POST /api/pbx/webhooks/voicemail-transcription
router.post("/webhooks/voicemail-transcription", async (req, res) => {
  const body = req.body as Record<string, string>;
  const RecordingSid = body["RecordingSid"] ?? "";
  const TranscriptionText = body["TranscriptionText"];
  const TranscriptionStatus = body["TranscriptionStatus"] ?? "";

  try {
    const status = TranscriptionStatus === "completed" ? "completed" as const : "failed" as const;
    await db
      .update(voicemails)
      .set({ transcription: TranscriptionText ?? null, transcriptionStatus: status })
      .where(eq(voicemails.twilioRecordingSid, RecordingSid));
  } catch (_err) {
  }

  return res.status(204).send();
});

// POST /api/pbx/webhooks/sms — inbound SMS
router.post("/webhooks/sms", async (req, res) => {
  res.setHeader("Content-Type", "text/xml");
  const body = req.body as Record<string, string>;
  const MessageSid = body["MessageSid"] ?? "";
  const From = body["From"] ?? "";
  const To = body["To"] ?? "";
  const Body = body["Body"] ?? "";
  const NumMedia = body["NumMedia"];

  try {
    await db.insert(smsMessages).values({
      tenantId: TENANT_ID,
      twilioMessageSid: MessageSid,
      direction: "inbound",
      fromNumber: From,
      toNumber: To,
      body: Body,
      status: "received",
      numMedia: NumMedia ? parseInt(NumMedia, 10) : 0,
    }).onConflictDoNothing();
  } catch (_err) {
  }

  return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
});

// POST /api/pbx/webhooks/sms-status
router.post("/webhooks/sms-status", async (req, res) => {
  const body = req.body as Record<string, string>;
  const MessageSid = body["MessageSid"] ?? "";
  const MessageStatus = body["MessageStatus"] ?? "";

  try {
    await db
      .update(smsMessages)
      .set({
        status: MessageStatus,
        ...(MessageStatus === "delivered" ? { deliveredAt: new Date() } : {}),
      })
      .where(eq(smsMessages.twilioMessageSid, MessageSid));
  } catch (_err) {
  }

  return res.status(204).send();
});

export default router;
