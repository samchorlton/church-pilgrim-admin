import Head from "next/head";
import Script from "next/script";

export default function AnnouncementsPage() {
  return (
    <>
      <Head>
        <title>Admin Panel - Announcements</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="/common.css" />
      </Head>
      <main className="wrap">
        <header className="header">
          <h1>Site Announcements</h1>
          <p className="note">Manage active and scheduled announcement banners.</p>
        </header>

        <nav className="top-nav">
          <a className="nav-link" href="/">Home</a>
          <a className="nav-link" href="/church-profiles">Church Profiles</a>
          <a className="nav-link" href="/moderation">Moderation</a>
          <a className="nav-link" href="/history-facts">History Facts</a>
          <a className="nav-link" href="/church-of-day">Church of the Day</a>
          <a className="nav-link active" href="/announcements">Announcements</a>
        </nav>

        <section className="panel">
          <div className="row">
            <button id="announcement-refresh-btn">Refresh</button>
            <button id="announcement-new-btn" className="ghost">New Announcement</button>
            <span id="announcement-status" className="mini"></span>
          </div>
          <div className="split">
            <div><div id="announcement-list" className="list"></div></div>
            <div>
              <div className="form-grid">
                <input id="a-id" placeholder="ID (for example: 2026-05-launch)" />
                <label className="row" htmlFor="a-is-active" style={{ alignItems: "center", gap: "8px" }}>
                  <input id="a-is-active" type="checkbox" defaultChecked />
                  <span>Active</span>
                </label>
                <textarea id="a-message" className="span-2" placeholder="Announcement message"></textarea>
                <label className="field-label" htmlFor="a-valid-from">Valid From</label>
                <input id="a-valid-from" type="datetime-local" />
                <label className="field-label" htmlFor="a-valid-to">Valid To (optional)</label>
                <input id="a-valid-to" type="datetime-local" />
              </div>
              <div className="row">
                <button id="announcement-save-btn">Save Announcement</button>
                <button id="announcement-delete-btn" className="danger">Delete Announcement</button>
                <span id="announcement-message" className="mini"></span>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Script src="/common.js" strategy="afterInteractive" />
    </>
  );
}
