import Head from "next/head";
import Script from "next/script";

export default function HistoryFactsPage() {
  return (
    <>
      <Head>
        <title>Admin Panel - History Facts</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="/common.css" />
      </Head>
      <main className="wrap">
        <header className="header">
          <h1>History Facts</h1>
          <p className="note">Manage daily historical facts served in the app.</p>
        </header>

        <nav className="top-nav">
          <a className="nav-link" href="/">Home</a>
          <a className="nav-link" href="/church-profiles">Church Profiles</a>
          <a className="nav-link" href="/moderation">Moderation</a>
          <a className="nav-link active" href="/history-facts">History Facts</a>
          <a className="nav-link" href="/church-of-day">Church of the Day</a>
        </nav>

        <section className="panel">
          <div className="row">
            <button id="fact-refresh-btn">Refresh Facts</button>
            <button id="fact-new-btn" className="ghost">New Fact</button>
            <input id="fact-filter-date" type="date" />
            <button id="fact-filter-btn" className="ghost">Filter Day</button>
            <button id="fact-clear-filter-btn" className="ghost">Clear Filter</button>
            <span id="fact-status" className="mini"></span>
          </div>
          <div className="split">
            <div><div id="fact-list" className="list"></div></div>
            <div>
              <div className="form-grid">
                <input id="f-id" placeholder="ID" disabled />
                <input id="f-year" placeholder="Year (optional)" />
                <input id="f-month" placeholder="Month (1-12)" />
                <input id="f-day" placeholder="Day (1-31)" />
                <input id="f-short-description" className="span-2" placeholder="Short description" />
                <textarea id="f-long-description" className="span-2" placeholder="Long description"></textarea>
              </div>
              <div className="row">
                <button id="fact-save-btn">Save Fact</button>
                <button id="fact-delete-btn" className="danger">Delete Fact</button>
                <span id="fact-message" className="mini"></span>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Script src="/common.js" strategy="afterInteractive" />
    </>
  );
}
