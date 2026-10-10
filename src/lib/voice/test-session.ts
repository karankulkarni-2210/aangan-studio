// Website voice tests: an in-browser Vaani WebRTC session started from the demo workspace.
// They are recorded as simulated calls (mock calendar, CRM and email) but use live AI extraction.

export const WEBSITE_VOICE_TEST = "website_voice_test";

/** The trigger-call body (echoed by Vaani as BYOL `req_body`) marks website tests in its metadata. */
export function isWebsiteVoiceTest(reqBody: Record<string, unknown> | null | undefined): boolean {
  const meta = reqBody?.metadata as Record<string, unknown> | undefined;
  return meta?.aangan_test === true;
}
