// Synthetic evaluation fixtures (all people, numbers and places invented). Kept outside src/ and
// separate from the runtime prompt so tests can reveal extraction or rule failures.
import ambiguousArea from "./ambiguous_area.json";
import declinedBooking from "./declined_booking.json";
import interruptedCall from "./interrupted_call.json";
import missingBudget from "./missing_budget.json";
import priceOnly from "./price_only.json";
import promptInjection from "./prompt_injection.json";
import suitableHome from "./suitable_home.json";
import unsupportedConstruction from "./unsupported_construction.json";

/** The five plan fixtures, then the extra demo/test scenarios. */
export const RAW_SCENARIOS: unknown[] = [
  suitableHome,
  unsupportedConstruction,
  missingBudget,
  priceOnly,
  interruptedCall,
  declinedBooking,
  promptInjection,
  ambiguousArea,
];
