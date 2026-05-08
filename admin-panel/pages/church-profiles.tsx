import Head from "next/head";
import Script from "next/script";

export default function ChurchProfilesPage() {
  return (
    <>
      <Head>
        <title>Admin Panel - Church Profiles</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="/common.css" />
      </Head>
      <main className="wrap">
        <header className="header">
          <h1>Church Profiles</h1>
          <p className="note">Edit content fields as used by the app.</p>
        </header>

        <nav className="top-nav">
          <a className="nav-link" href="/">Home</a>
          <a className="nav-link active" href="/church-profiles">Church Profiles</a>
          <a className="nav-link" href="/moderation">Moderation</a>
          <a className="nav-link" href="/history-facts">History Facts</a>
          <a className="nav-link" href="/church-of-day">Church of the Day</a>
        </nav>

        <section className="panel">
          <div className="row profile-search-row">
            <input id="profile-query" placeholder="Search title or list entry" />
            <select id="profile-status-filter">
              <option value="">All statuses</option>
              <option value="draft">draft</option>
              <option value="review">review</option>
              <option value="live">live</option>
              <option value="archived">archived</option>
            </select>
            <select id="profile-moderation-filter">
              <option value="">All moderation states</option>
              <option value="outstanding">Outstanding moderation</option>
            </select>
            <input id="profile-county-filter" placeholder="Filter county/district" />
            <input id="profile-town-filter" placeholder="Filter town/parish" />
            <button id="profile-search-btn">Search</button>
            <button id="profile-clear-filters-btn" className="ghost">Clear</button>
            <button id="profile-new-btn" className="ghost">New Profile</button>
            <span id="profile-status" className="mini"></span>
          </div>

          <div className="split">
            <div><div id="profile-list" className="list"></div></div>
            <div>
              <div id="profile-tabs" className="tab-nav" role="tablist" aria-label="Profile editor sections">
                <button id="tab-btn-core" type="button" className="tab-btn active" data-tab-target="core" role="tab" aria-selected="true" aria-controls="tab-panel-core">Core Information</button>
                <button id="tab-btn-details" type="button" className="tab-btn" data-tab-target="details" role="tab" aria-selected="false" aria-controls="tab-panel-details">Additional Details</button>
                <button id="tab-btn-moderation" type="button" className="tab-btn" data-tab-target="moderation" role="tab" aria-selected="false" aria-controls="tab-panel-moderation">Content Moderation</button>
              </div>

              <section id="tab-panel-core" className="tab-panel active" role="tabpanel" aria-labelledby="tab-btn-core">
                <div className="form-grid">
                  <input id="p-list-entry" placeholder="List Entry" />
                  <input id="p-title" placeholder="Title" />
                  <input id="p-subtitle" placeholder="Subtitle" />
                  <select id="p-editorial-status">
                    <option value="">Select editorial status</option>
                    <option value="draft">draft</option>
                    <option value="review">review</option>
                    <option value="live">live</option>
                    <option value="archived">archived</option>
                  </select>
                  <select id="p-active-status">
                    <option value="">Select church status</option>
                    <option value="Active Church">Active Church</option>
                    <option value="Occasional Worship">Occasional Worship</option>
                    <option value="Private Ownership">Private Ownership</option>
                    <option value="Converted Use">Converted Use</option>
                    <option value="Ruined">Ruined</option>
                    <option value="Derelict">Derelict</option>
                    <option value="Preserved Historic Site">Preserved Historic Site</option>
                    <option value="Closed Church">Closed Church</option>
                    <option value="Demolished">Demolished</option>
                    <option value="Current Use Unknown">Current Use Unknown</option>
                  </select>
                  <input id="p-church-website" className="span-2" placeholder="Church website URL" />
                  <h3 className="subsection-title span-2">Hero Image (App)</h3>
                  <input id="p-hero-image-url" className="span-2" placeholder="Hero image URL (used in app)" />
                  <input id="p-hero-image-source-url" className="span-2" placeholder="Image source link (optional)" />
                  <input id="p-hero-date-label" className="span-2" placeholder="Construction Date (for example: c.1180-1450)" />
                  <div className="span-2 row">
                    <input id="p-hero-image-file" type="file" accept="image/*" />
                    <button id="p-hero-image-upload-btn" type="button">Upload to Supabase</button>
                  </div>
                  <a id="p-hero-image-link" className="mini span-2" href="#" target="_blank" rel="noreferrer" style={{ display: "none" }}></a>
                  <img id="p-hero-image-preview" alt="Hero preview" className="hero-preview span-2" style={{ display: "none" }} />
                  <input id="p-editorial-status-custom" className="span-2" placeholder="Optional custom status" />
                  <select id="p-tags-select" className="span-2" multiple>
                    <option value="ancient-origins">ancient-origins</option>
                    <option value="medieval">medieval</option>
                    <option value="reformation">reformation</option>
                    <option value="revival-mission">revival-mission</option>
                    <option value="hidden-gems">hidden-gems</option>
                  </select>
                  <input id="p-tags-custom" className="span-2" placeholder="Optional custom tags (comma separated)" />
                  <textarea id="p-summary" className="span-2" placeholder="Summary shown in cards and as fallback overview. Keep to 2-4 sentences."></textarea>
                  <h3 className="subsection-title span-2">Content Blocks (App)</h3>
                  <p className="field-help span-2">These map directly to the app tabs. Write complete prose for visitors, not source notes.</p>
                  <label className="field-label span-2" htmlFor="p-history">History Tab Content</label>
                  <textarea id="p-history" className="span-2" placeholder="History tab: Build phases, key dates/periods, restorations, notable events, and historical context (chronological narrative)."></textarea>
                  <label className="field-label span-2" htmlFor="p-architecture">Architecture Tab Content</label>
                  <textarea id="p-architecture" className="span-2" placeholder="Architecture tab: Plan/layout, style(s), materials, external/interior highlights, fittings, and distinctive features visitors should notice."></textarea>
                  <h3 className="subsection-title span-2">Church Plan (Architecture Tab)</h3>
                  <p className="field-help span-2">URL of a floor plan or layout diagram image for this church. Shown on the Architecture tab.</p>
                  <input id="p-plan-url" className="span-2" placeholder="Church plan image URL" />
                  <div className="span-2 row">
                    <input id="p-plan-image-file" type="file" accept="image/*" />
                    <button id="p-plan-image-upload-btn" type="button">Upload Plan Image</button>
                  </div>
                  <a id="p-plan-image-link" className="mini span-2" href="#" target="_blank" rel="noreferrer" style={{ display: "none" }}></a>
                  <img id="p-plan-image-preview" alt="Church plan preview" className="hero-preview span-2" style={{ display: "none" }} />
                </div>
              </section>

              <section id="tab-panel-details" className="tab-panel" role="tabpanel" aria-labelledby="tab-btn-details">
                <div className="form-grid">
                  <h3 className="subsection-title span-2">Timeline (App)</h3>
                  <p className="field-help span-2">One event per line as <code>YEAR | EVENT</code>. Use broad dates when exact year is unknown (for example <code>c.1200</code>).</p>
                  <label className="field-label span-2" htmlFor="p-timeline-events">Timeline Card Entries</label>
                  <textarea id="p-timeline-events" className="span-2" placeholder="One per line: YEAR | EVENT"></textarea>
                  <h3 className="subsection-title span-2">Location (App)</h3>
                  <p className="field-help span-2">Used to improve subtitle/location display in lists and map context.</p>
                  <input id="p-location-county" placeholder="County" />
                  <input id="p-location-district" placeholder="District" />
                  <input id="p-location-parish" className="span-2" placeholder="Parish" />
                  <h3 className="subsection-title span-2">Supplementary (App)</h3>
                  <p className="field-help span-2">Reference/supporting material. This is secondary to the visitor-facing content blocks above.</p>
                  <label className="field-label span-2" htmlFor="p-supp-source-summary">Supplementary Source Summary</label>
                  <textarea id="p-supp-source-summary" className="span-2" placeholder="Source summary: concise archival/listing summary text (optional)."></textarea>
                  <label className="field-label span-2" htmlFor="p-supp-source-history">Supplementary Source History</label>
                  <textarea id="p-supp-source-history" className="span-2" placeholder="Source history: verbatim or near-verbatim historical source extract (optional)."></textarea>
                  <label className="field-label span-2" htmlFor="p-supp-source-details">Supplementary Source Details</label>
                  <textarea id="p-supp-source-details" className="span-2" placeholder="Source details: technical listing details and evidence notes (optional)."></textarea>
                  <label className="field-label span-2" htmlFor="p-supp-reasons">Reasons for Designation</label>
                  <textarea id="p-supp-reasons" className="span-2" placeholder="Reasons for designation: one reason per line, plain language."></textarea>
                  <input id="p-supp-listed-date" placeholder="Listed date" />
                  <select id="p-supp-grade">
                    <option value="">Select grade</option>
                    <option value="I">I</option>
                    <option value="II*">II*</option>
                    <option value="II">II</option>
                  </select>
                  <input id="p-supp-grade-custom" className="span-2" placeholder="Optional custom grade" />
                  <h3 className="subsection-title span-2">Editorial</h3>
                  <p className="field-help span-2">Internal notes for maintainers. Not intended for end-user display.</p>
                  <textarea id="p-editorial-notes" className="span-2" placeholder="Editorial notes: pending checks, unresolved facts, follow-up tasks."></textarea>
                </div>
              </section>

              <section id="tab-panel-moderation" className="tab-panel" role="tabpanel" aria-labelledby="tab-btn-moderation">
                <div className="embedded-panel">
                  <h2>Content Submissions</h2>
                  <p className="note">Review and approve text, image, and audio contributions in context of this church profile.</p>
                  <div className="row">
                    <select id="profile-mod-view-filter">
                      <option value="approvals">pending approvals</option>
                      <option value="uploads">new user uploads</option>
                    </select>
                    <select id="profile-mod-status-filter">
                      <option value="pending">pending</option>
                      <option value="approved">approved</option>
                      <option value="rejected">rejected</option>
                      <option value="">all statuses</option>
                    </select>
                    <select id="profile-mod-memory-type-filter">
                      <option value="">all memories/people</option>
                      <option value="memory">memory</option>
                      <option value="tradition">tradition</option>
                      <option value="people">people</option>
                    </select>
                    <button id="profile-mod-refresh-btn" type="button">Refresh</button>
                    <span id="profile-mod-status" className="mini"></span>
                  </div>

                  <h3 className="subsection-title">Text Contributions</h3>
                  <div id="profile-mod-text-list" className="queue-list"></div>
                  <h3 className="subsection-title">Image Contributions</h3>
                  <div id="profile-mod-image-list" className="queue-list"></div>
                  <h3 className="subsection-title">Audio Contributions</h3>
                  <div id="profile-mod-audio-list" className="queue-list"></div>
                  <h3 className="subsection-title">Memories / Traditions / People</h3>
                  <div id="profile-mod-memory-list" className="queue-list"></div>

                  <h3 className="subsection-title">Stories & Folklore (Admin Create)</h3>
                  <p className="note">Create folklore stories that will be auto-approved and appear in the Stories & Folklore tab.</p>
                  <div className="form-grid">
                    <input id="p-folklore-title" className="span-2" placeholder="Story title (optional)" />
                    <textarea id="p-folklore-text" className="span-2" placeholder="Folklore story text (legends, ghost stories, local traditions, etc.)"></textarea>
                    <div className="span-2 row">
                      <button id="p-folklore-create-btn" type="button">Create Folklore Story</button>
                      <span id="p-folklore-status" className="mini"></span>
                    </div>
                  </div>
                </div>
              </section>

              <div className="row">
                <button id="profile-save-btn">Save Profile</button>
                <button id="profile-delete-btn" className="danger">Delete Profile</button>
                <span id="profile-message" className="mini"></span>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Script src="/common.js" strategy="afterInteractive" />
    </>
  );
}
