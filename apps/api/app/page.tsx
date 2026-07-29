const sections = [
  "Political Spectrum",
  "Bias",
  "Journalist Context",
  "Supporting Information",
  "Contradicting Information",
  "Additional Context",
  "Works Cited",
];

export default function Home() {
  return (
    <main>
      <p className="eyebrow">Perspectica</p>
      <h1>The analysis service is running.</h1>
      <p>
        This proof of concept accepts a normalized news article and streams validated analysis
        sections to the browser extension.
      </p>
      <div className="status">
        <span aria-hidden="true" />
        Demo analysis is available
      </div>
      <ul>
        {sections.map((section) => (
          <li key={section}>{section}</li>
        ))}
      </ul>
      <p className="endpoint">
        Health: <code>GET /api/health</code>
        <br />
        Analyze: <code>POST /api/analyze</code>
      </p>
    </main>
  );
}
