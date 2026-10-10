import { route } from "@/lib/http/route";
import { bookingsQuerySchema, listBookings } from "@/lib/services/directory";

// Contract addition: consultations across leads (row-level security applies; designers see their own).
export const GET = route({ auth: "staff", rateLimitPerMinute: 120 }, async ({ db, staff, query }) => listBookings(db, staff!, query(bookingsQuerySchema)));
