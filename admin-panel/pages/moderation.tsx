import Head from "next/head";
import Script from "next/script";

export default function ModerationPage() {
  return (
    <>
      <Head>
        <title>Admin Panel - Moderation</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="/common.css" />
      </Head>
      <main className="wrap">
        <header className="header">
          <h1>Moderation</h1>
          <p className="note">Outstanding moderation tasks grouped by church listing.</p>
        </header>

        <nav className="top-nav">
          <a className="nav-link" href="/">Home</a>
          <a className="nav-link" href="/church-profiles">Church Profiles</a>
          <a className="nav-link active" href="/moderation">Moderation</a>
          <a className="nav-link" href="/history-facts">History Facts</a>
          <a className="nav-link" href="/church-of-day">Church of the Day</a>
          <a className="nav-link" href="/announcements">Announcements</a>
        </nav>

        <section className="panel">
          <div className="row">
            <button id="moderation-refresh-btn">Refresh</button>
            <span id="moderation-status" className="mini"></span>
          </div>
          <div id="moderation-list" className="queue-list"></div>
        </section>

        <section className="panel">
          <h2>Church Listing Submissions</h2>
          <p className="note">Review pending church listing submissions and approve them into the canonical listing table.</p>
          <div className="row">
            <select id="listing-submissions-status-filter">
              <option value="pending">pending</option>
              <option value="approved">approved</option>
              <option value="rejected">rejected</option>
              <option value="duplicate">duplicate</option>
            </select>
            <button id="listing-submissions-refresh-btn" className="ghost">Refresh Submissions</button>
            <span id="listing-submissions-status" className="mini"></span>
          </div>
          <div id="listing-submissions-list" className="queue-list"></div>
        </section>
      </main>
      <Script src="/common.js" strategy="afterInteractive" />
    </>
  );
}
