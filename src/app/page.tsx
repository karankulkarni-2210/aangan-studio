import Link from "next/link";
import { ArchMark } from "@/ui/components";

export default function Welcome() {
  return (
    <main id="main" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "40px 16px" }}>
      <div className="stack lg" style={{ maxWidth: 560, alignItems: "center", textAlign: "center" }}>
        <ArchMark size={64} />
        <div className="brand-sub" style={{ fontSize: 14 }}>Aangan Studio · Every enquiry, thoughtfully handled.</div>
        <h1 className="page-title" style={{ fontSize: "clamp(40px, 6vw, 60px)" }}>Welcome, Nikhil.</h1>
        <p className="page-lede" style={{ margin: 0 }}>
          Your phone assistant answers every enquiry, gathers the project details, qualifies the lead against your rules and books a consultation. Pricing, commitments and complaints always come back to you.
        </p>
        <Link href="/overview" className="btn primary lg">Get started</Link>
        <p className="tiny muted" style={{ margin: 0 }}>Demo workspace with sample enquiries. No real customer data is shown.</p>
      </div>
    </main>
  );
}
