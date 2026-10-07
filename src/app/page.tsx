// Placeholder only: the frontend is designed and built by Codex against openapi.json.
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 640 }}>
      <h1>Aangan Studio phone-enquiry backend</h1>
      <p>
        <strong>Demo data and sample business rules.</strong> Calls in demo mode are simulated; they do not prove live phone answering.
      </p>
      <p>
        API contract: <code>openapi.json</code>. Liveness: <a href="/health">/health</a>. Readiness: <a href="/ready">/ready</a>.
      </p>
    </main>
  );
}
