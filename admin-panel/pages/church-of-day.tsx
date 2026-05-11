import Head from "next/head";
import Script from "next/script";

export default function ChurchOfDayPage() {
  return (
    <>
      <Head>
        <title>Admin Panel - Church of the Day</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="/common.css" />
      </Head>
      <main className="wrap">
        <header className="header">
          <h1>Church of the Day</h1>
          <p className="note">Manage the daily featured church shown consistently to all users.</p>
        </header>

        <nav className="top-nav">
          <a className="nav-link" href="/">Home</a>
          <a className="nav-link" href="/church-profiles">Church Profiles</a>
          <a className="nav-link" href="/moderation">Moderation</a>
          <a className="nav-link" href="/history-facts">History Facts</a>
          <a className="nav-link active" href="/church-of-day">Church of the Day</a>
          <a className="nav-link" href="/announcements">Announcements</a>
        </nav>

        <section className="panel">
          <div className="row">
            <input id="cod-filter-date" type="date" />
            <button id="cod-filter-btn" className="ghost">Filter Date</button>
            <button id="cod-clear-filter-btn" className="ghost">Clear Filter</button>
            <button id="cod-refresh-btn">Refresh Entries</button>
            <button id="cod-new-btn" className="ghost">New Entry</button>
            <span id="cod-status" className="mini"></span>
          </div>
          <div className="split">
            <div><div id="cod-list" className="list"></div></div>
            <div>
              <div className="form-grid">
                <input id="cod-feature-date" placeholder="Feature date (YYYY-MM-DD)" />
                <input id="cod-list-entry" placeholder="List entry" />
                <textarea id="cod-rich-summary" className="span-2" placeholder="Rich summary override (optional). If blank, app uses profile summary fallback."></textarea>
              </div>
              <div className="row">
                <button id="cod-save-btn">Save Entry</button>
                <button id="cod-delete-btn" className="danger">Delete Entry</button>
                <span id="cod-message" className="mini"></span>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Script src="/common.js" strategy="afterInteractive" />
    </>
  );
}
