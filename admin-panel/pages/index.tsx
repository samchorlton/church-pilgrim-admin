import Head from "next/head";
import Script from "next/script";

export default function HomePage() {
  return (
    <>
      <Head>
        <title>Church Pilgrim Admin Panel</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="/common.css" />
      </Head>
      <main className="wrap">
        <header className="header">
          <h1>Church Pilgrim Admin Panel</h1>
        </header>

        <nav className="top-nav">
          <a className="nav-link active" href="/">Home</a>
          <a className="nav-link" href="/church-profiles">Church Profiles</a>
          <a className="nav-link" href="/moderation">Moderation</a>
          <a className="nav-link" href="/history-facts">History Facts</a>
          <a className="nav-link" href="/church-of-day">Church of the Day</a>
          <a className="nav-link" href="/announcements">Announcements</a>
        </nav>

        <section className="panel">
          <h2>Functions</h2>
          <div className="grid">
            <a className="tile" href="/church-profiles">
              <h3>Church Profiles</h3>
              <p>Edit app-facing profile content, tags, and timeline.</p>
            </a>
            <a className="tile" href="/history-facts">
              <h3>History Facts</h3>
              <p>Manage daily church history facts used by the app.</p>
            </a>
            <a className="tile" href="/moderation">
              <h3>Moderation</h3>
              <p>Review outstanding contributions and memories by church listing.</p>
            </a>
            <a className="tile" href="/church-of-day">
              <h3>Church of the Day</h3>
              <p>Set the daily featured church and optional rich summary override.</p>
            </a>
            <a className="tile" href="/announcements">
              <h3>Announcements</h3>
              <p>Manage active and scheduled site announcements.</p>
            </a>
          </div>
        </section>
      </main>
      <Script src="/common.js" strategy="afterInteractive" />
    </>
  );
}
