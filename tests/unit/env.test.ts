import { beforeEach, describe, expect, it } from "vitest";
import { env, integrationMode, missingEnv, parseCalEventTypeId } from "@/lib/config/env";
import { configureTestEnv } from "../helpers/env";

beforeEach(() => configureTestEnv());

describe("environment names from the studio's setup notes", () => {
  it("accepts the alias names and reports canonical names", () => {
    Object.assign(process.env, { CAL_API_KEY: "cal_test_x", CAL_EVENT_TYPE_ID: "https://app.cal.com/event-types/7421657?tabName=setup&month=2026-11" });
    expect(env.calcom()).toMatchObject({ apiKey: "cal_test_x", eventTypeId: "7421657" });
    expect(integrationMode("calcom")).toBe("live");
    Object.assign(process.env, { HUBSPOT_ACCESS_TOKEN: "pat-test", HUBSPOT_PIPELINE_ID: "default" });
    expect(missingEnv(["HUBSPOT_ACCESS_TOKEN", "HUBSPOT_PIPELINE_ID", "HUBSPOT_DEALSTAGE_ID"])).toEqual(["HUBSPOT_DEALSTAGE_ID"]);
    process.env.HUBSPOT_QUALIFIED_STAGE_ID = "qualifiedtobuy";
    expect(env.hubspot().dealStageId).toBe("qualifiedtobuy");
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.APP_BASE_URL = "";
    expect(env.appBaseUrl()).toBe("http://localhost:3000");
    process.env.RESEND_FROM_EMAIL = "onboarding@resend.dev";
    expect(env.resend().from).toBe("onboarding@resend.dev");
  });

  it("ignores an event-type value it cannot parse instead of guessing", () => {
    expect(parseCalEventTypeId("7421657")).toBe("7421657");
    expect(parseCalEventTypeId("my-event")).toBeUndefined();
    process.env.CAL_API_KEY = "cal_test_x";
    process.env.CAL_EVENT_TYPE_ID = "my-event";
    expect(integrationMode("calcom")).toBe("mock");
  });

  it("strips pasted quotes (including curly quotes) and validates the redirect address", () => {
    process.env.DESIGNER_HANDOFF_EMAIL = "“designer@example.com”";
    expect(env.handoffRedirectEmail()).toBe("designer@example.com");
    process.env.DESIGNER_HANDOFF_EMAIL = "not an email";
    expect(env.handoffRedirectEmail()).toBeUndefined();
  });
});
