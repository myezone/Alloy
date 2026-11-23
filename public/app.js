/* Russ Community Credit Union (Demo): application front end.
   Plain JavaScript, no build step. The browser only ever talks to this app's own
   /api endpoints (the mock ESB). It never calls Alloy's REST API and never holds credentials.
   The one exception is step-up: Alloy's SDK uploads ID images straight to Alloy. */
(function () {
  'use strict';

  // ------------------------------------------------------------ state
  const STEPS = [
    { id: 'route', label: 'Getting started', left: 'About 5 minutes left' },
    { id: 'welcome', label: 'Welcome', left: 'About 4 minutes left' },
    { id: 'contact', label: 'Contact', left: 'About 3 minutes left' },
    { id: 'about', label: 'About you', left: 'About 2 minutes left' },
    { id: 'address', label: 'Address', left: 'About 1 minute left' },
    { id: 'review', label: 'Review', left: 'Almost done' },
  ];
  const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

  // Test applicants. The postal code selects a sandbox profile in the Alloy account.
  const PERSONAS = [
    { key: 'approved', label: 'Approved', color: '#2E8B57', postal: '33602', first: 'Avery', last: 'Stone' },
    { key: 'stepup', label: 'Step-Up', color: '#D2B414', postal: '00001', first: 'Jordan', last: 'Blake' },
    { key: 'denied', label: 'Denied', color: '#A31C67', postal: '00002', first: 'Casey', last: 'Rivers' },
    { key: 'review', label: 'Manual review', color: '#6E8CD7', postal: '00003', first: 'Morgan', last: 'Lane' },
    { key: 'review2', label: 'Review (identity)', color: '#6E8CD7', postal: '00004', first: 'Riley', last: 'Hart' },
  ];

  const state = {
    view: 'route',
    config: { mode: 'mock', institution: 'Russ Community Credit Union' },
    route: { member: null, product: null, owner: null, residency: null },
    consent: { notice: false, esign: false, marketing: false, certify: false },
    form: { firstName: '', lastName: '', birthDate: '', ssn: '', email: '', phone: '', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '', mailingSame: true },
    app: null,
    errors: {},
    showSsn: false,
    pollTimer: null,
    lookupError: '',
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const TRI = '<svg class="tri" viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0 10 6 0 12Z" fill="currentColor"/></svg>';
  const CHECK = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="#A31C67" stroke-width="1.5"/></svg>';

  // ------------------------------------------------------------ formatting and validation
  const fmtPhone = (v) => { const d = digits(v).slice(0, 10); if (d.length < 4) return d; if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`; return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`; };
  const fmtSsn = (v) => { const d = digits(v).slice(0, 9); if (d.length < 4) return d; if (d.length < 6) return `${d.slice(0, 3)}-${d.slice(3)}`; return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`; };
  const maskSsn = (v) => { const d = digits(v); return d.length === 9 ? `***-**-${d.slice(5)}` : ''; };
  const age = (iso) => { const b = new Date(iso + 'T00:00:00'); if (isNaN(b)) return NaN; const t = new Date(); let a = t.getFullYear() - b.getFullYear(); if (t < new Date(t.getFullYear(), b.getMonth(), b.getDate())) a--; return a; };

  const RULES = {
    phone: (f) => (digits(f.phone).length === 10 ? '' : 'Enter a 10-digit mobile number.'),
    email: (f) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email) ? '' : 'Enter an email address, like name@example.com.'),
    firstName: (f) => (f.firstName.trim() ? '' : 'Enter your legal first name.'),
    lastName: (f) => (f.lastName.trim() ? '' : 'Enter your legal last name.'),
    birthDate: (f) => { const a = age(f.birthDate); if (isNaN(a)) return 'Enter your date of birth.'; if (a < 18) return 'You must be 18 or older to apply online.'; if (a > 120) return 'Check the year of birth.'; return ''; },
    ssn: (f) => (digits(f.ssn).length === 9 ? '' : 'Enter all 9 digits of your Social Security number.'),
    addressLine1: (f) => (f.addressLine1.trim() ? '' : 'Enter your street address.'),
    city: (f) => (f.city.trim() ? '' : 'Enter your city.'),
    state: (f) => (f.state ? '' : 'Choose your state.'),
    postalCode: (f) => (/^\d{5}$/.test(f.postalCode) ? '' : 'Enter a 5-digit ZIP code.'),
  };
  const VIEW_FIELDS = { contact: ['phone', 'email'], about: ['firstName', 'lastName', 'birthDate', 'ssn'], address: ['addressLine1', 'city', 'state', 'postalCode'] };
  const FIELD_NAMES = { phone: 'mobile number', email: 'email', firstName: 'first name', lastName: 'last name', birthDate: 'date of birth', ssn: 'Social Security number', addressLine1: 'street address', city: 'city', state: 'state', postalCode: 'ZIP code' };

  function check(fields) {
    const errs = {};
    for (const k of fields) { const m = RULES[k](state.form); if (m) errs[k] = m; }
    return errs;
  }

  // ------------------------------------------------------------ small render helpers
  function field(key, label, opts = {}) {
    const f = state.form, err = state.errors[key];
    const type = opts.type || 'text';
    const val = key === 'ssn' ? (state.showSsn ? fmtSsn(f.ssn) : (digits(f.ssn).length === 9 ? maskSsn(f.ssn) : fmtSsn(f.ssn))) : f[key];
    const input = opts.select
      ? `<select class="input" id="f-${key}" data-field="${key}" ${err ? 'aria-invalid="true"' : ''} aria-describedby="e-${key}" autocomplete="${opts.ac || 'off'}"><option value="">Choose</option>${opts.select.map((o) => `<option ${f[key] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
      : `<input class="input" id="f-${key}" data-field="${key}" type="${type}" value="${esc(val)}" ${opts.mode ? `inputmode="${opts.mode}"` : ''} ${opts.ph ? `placeholder="${esc(opts.ph)}"` : ''} ${opts.max ? `maxlength="${opts.max}"` : ''} autocomplete="${opts.ac || 'off'}" ${err ? 'aria-invalid="true"' : ''} aria-describedby="e-${key}${opts.help ? ` h-${key}` : ''}">`;
    const wrapped = opts.toggle ? `<div class="with-btn">${input}<button type="button" class="link-btn" data-action="toggle-ssn" aria-pressed="${state.showSsn}">${state.showSsn ? 'Hide' : 'Show'}</button></div>` : input;
    return `<div class="field ${opts.full ? 'full' : ''}">
      <label for="f-${key}">${label}${opts.optional ? ' <span class="opt">(optional)</span>' : ''}</label>
      ${wrapped}
      ${opts.help ? `<div class="help" id="h-${key}">${opts.help}</div>` : ''}
      <div class="err" id="e-${key}" role="alert">${esc(err || '')}</div>
    </div>`;
  }

  function nav(backTo, nextLabel, nextAction, missing) {
    return `<div class="actions">
      ${backTo ? `<button type="button" class="btn btn-outline" data-go="${backTo}">Back</button>` : '<span></span>'}
      <div class="actions-right"><button type="button" class="btn btn-fill" data-action="${nextAction}">${nextLabel}${TRI}</button></div>
      <div class="hint-missing" role="status">${missing ? esc(missing) : ''}</div>
    </div>`;
  }

  function personaTools() {
    return `<div class="demo-tools" aria-label="Demo tools">
      <div class="eyebrow">Demo tools: fill with a test applicant</div>
      <div class="row">${PERSONAS.map((p) => `<button type="button" class="persona" data-persona="${p.key}"><i style="background:${p.color}"></i>${p.label}</button>`).join('')}</div>
      <div class="help">Each test applicant uses a postal code tied to a sandbox profile in Alloy. All data is invented.</div>
    </div>`;
  }

  const routeSummary = () => {
    const r = state.route, out = [];
    if (r.member) out.push(r.member === 'new' ? 'New member' : 'Existing member');
    if (r.product) out.push(r.product === 'deposit' ? 'Checking and savings' : 'Loan or credit card');
    if (r.owner) out.push(r.owner === 'personal' ? 'Personal' : 'Business');
    if (r.residency) out.push(r.residency === 'resident' ? 'U.S. citizen or resident' : 'Non-resident');
    return out;
  };

  // ------------------------------------------------------------ views
  const VIEWS = {};

  VIEWS.route = () => {
    const r = state.route;
    const q = (key, title, a, b) => `<div class="q">
        <h3 id="q-${key}">${title}</h3>
        <div class="choices" role="group" aria-labelledby="q-${key}">
          ${[a, b].map((o) => `<button type="button" class="choice" data-route="${key}" data-value="${o.v}" aria-pressed="${r[key] === o.v}">${o.t}<small>${o.s}</small></button>`).join('')}
        </div></div>`;
    const done = r.member && r.product && r.owner && r.residency;
    return `<div class="card-head">
        <div class="eyebrow">Open an account</div>
        <h1>Let's find the right application for you.</h1>
        <p class="lede">Four quick questions. Your answers decide which application and identity checks you get.</p>
      </div>
      ${q('member', 'Are you new to Russ Community Credit Union?', { v: 'new', t: 'Yes, I\'m new', s: 'Become a member today' }, { v: 'existing', t: 'I\'m already a member', s: 'Add an account' })}
      ${r.member ? q('product', 'What would you like to open?', { v: 'deposit', t: 'Checking and savings', s: 'Everyday accounts' }, { v: 'loan', t: 'Loan or credit card', s: 'Borrowing' }) : ''}
      ${r.product ? q('owner', 'Who is the account for?', { v: 'personal', t: 'For me', s: 'A personal account' }, { v: 'business', t: 'For my business', s: 'A business account' }) : ''}
      ${r.owner ? q('residency', 'What is your U.S. residency status?', { v: 'resident', t: 'U.S. citizen or permanent resident', s: 'Most applicants' }, { v: 'nonresident', t: 'Non-resident', s: 'Different documents apply' }) : ''}
      ${nav(null, 'Continue', 'route-next', done ? '' : 'Answer each question to continue.')}`;
  };

  VIEWS.otherPath = () => {
    const r = state.route;
    const why = r.member === 'existing' ? ['Existing member', 'We already know you. A shorter journey would confirm your identity against your member record and skip checks you passed when you joined.']
      : r.product === 'loan' ? ['Lending', 'Loans and cards add credit and income checks, so they run through a lending journey with its own policy.']
        : r.owner === 'business' ? ['Business', 'Business accounts verify the business and its owners, which is a separate business onboarding journey.']
          : ['Non-resident', 'Non-resident applicants provide different identity documents, so a journey with a document-first policy applies.'];
    return `<div class="card-head">
        <div class="eyebrow">A different path</div>
        <h1>This choice uses a different journey.</h1>
        <p class="lede">${why[1]}</p>
      </div>
      <div class="panel"><div class="eyebrow">In this demo</div>
        <p>The fully built path is a new member opening a personal checking and savings account. The X-ray panel shows which Alloy journey each answer would select.</p>
        <div class="chips">${routeSummary().map((c) => `<span class="pill">${esc(c)}</span>`).join('')}</div></div>
      <div class="actions"><button type="button" class="btn btn-outline" data-go="route">Change my answers</button>
        <div class="actions-right"><button type="button" class="btn btn-fill" data-action="use-built-path">Use the built path${TRI}</button></div></div>`;
  };

  VIEWS.welcome = () => {
    const c = state.consent;
    return `<div class="card-head">
        <div class="eyebrow">Welcome</div>
        <h1>Membership starts here. It takes about four minutes.</h1>
        <div class="chips">${routeSummary().map((x) => `<span class="pill">${esc(x)}</span>`).join('')}<button type="button" class="link-btn" data-go="route">Change</button></div>
      </div>
      <div class="panel"><div class="eyebrow">Have these ready</div>
        <ul class="need">
          <li>${CHECK}<span>Your Social Security number</span></li>
          <li>${CHECK}<span>Your home address and mobile number</span></li>
          <li>${CHECK}<span>A photo ID, only if we need a closer look</span></li>
        </ul></div>
      <details class="why"><summary>Why we verify your identity</summary>
        <p>Federal law requires every financial institution to obtain, verify, and record information that identifies each person who opens an account. We ask for your name, address, date of birth, and Social Security number, and we may ask to see identifying documents.</p></details>
      <label class="check"><input type="checkbox" data-consent="notice" ${c.notice ? 'checked' : ''}><span>I have read the identity verification notice.</span></label>
      <label class="check"><input type="checkbox" data-consent="esign" ${c.esign ? 'checked' : ''}><span>I agree to receive disclosures and records electronically.</span></label>
      <label class="check"><input type="checkbox" data-consent="marketing" ${c.marketing ? 'checked' : ''}><span>Send me offers by text and email. <span class="muted">Optional. You can change this any time.</span></span></label>
      ${nav('route', 'Start application', 'welcome-next', c.notice && c.esign ? '' : 'Confirm the first two boxes to continue.')}`;
  };

  VIEWS.contact = () => `<div class="card-head">
      <div class="eyebrow">Step 1 of 4</div>
      <h1>How can we reach you?</h1>
      <p class="lede">We use these to confirm it's you and to send updates on your application.</p>
    </div>
    ${personaTools()}
    <div class="grid">
      ${field('phone', 'Mobile number', { type: 'tel', mode: 'tel', ph: '(555) 555-0100', ac: 'tel-national', full: true })}
      ${field('email', 'Email', { type: 'email', mode: 'email', ph: 'name@example.com', ac: 'email', full: true })}
    </div>
    ${nav('welcome', 'Continue', 'next:about')}`;

  VIEWS.about = () => `<div class="card-head">
      <div class="eyebrow">Step 2 of 4</div>
      <h1>Tell us about you.</h1>
      <p class="lede">Use your legal name, exactly as it appears on your ID.</p>
    </div>
    ${personaTools()}
    <div class="grid">
      ${field('firstName', 'Legal first name', { ac: 'given-name' })}
      ${field('lastName', 'Legal last name', { ac: 'family-name' })}
      ${field('birthDate', 'Date of birth', { type: 'date', ac: 'bday' })}
      ${field('ssn', 'Social Security number', { mode: 'numeric', ph: '000-00-0000', max: 11, toggle: true })}
    </div>
    <details class="why"><summary>Why we ask for your Social Security number</summary>
      <p>It lets us verify your identity and protect you from someone opening an account in your name. It is encrypted in transit and is never shown in full on screen.</p></details>
    ${nav('contact', 'Continue', 'next:address')}`;

  VIEWS.address = () => `<div class="card-head">
      <div class="eyebrow">Step 3 of 4</div>
      <h1>Where do you live?</h1>
      <p class="lede">Your home address, not a P.O. box.</p>
    </div>
    ${personaTools()}
    <div class="grid">
      ${field('addressLine1', 'Street address', { ac: 'address-line1', full: true })}
      ${field('addressLine2', 'Apartment, suite, unit', { ac: 'address-line2', full: true, optional: true })}
      ${field('city', 'City', { ac: 'address-level2' })}
      ${field('state', 'State', { select: STATES, ac: 'address-level1' })}
      ${field('postalCode', 'ZIP code', { mode: 'numeric', max: 5, ac: 'postal-code' })}
    </div>
    <label class="check"><input type="checkbox" data-form-check="mailingSame" ${state.form.mailingSame ? 'checked' : ''}><span>My mailing address is the same.</span></label>
    ${nav('about', 'Review', 'next:review')}`;

  VIEWS.review = () => {
    const f = state.form;
    const row = (label, value, go) => `<div class="summary-row"><dt>${label}</dt><dd>${value}</dd><button type="button" class="link-btn" data-go="${go}" aria-label="Edit ${label.toLowerCase()}">Edit</button></div>`;
    return `<div class="card-head">
        <div class="eyebrow">Step 4 of 4</div>
        <h1>Check your details, then submit.</h1>
        <p class="lede">You will get a decision in seconds.</p>
      </div>
      <dl class="summary">
        ${row('Account', esc(routeSummary().join(' · ')), 'route')}
        ${row('Name', esc(`${f.firstName} ${f.lastName}`), 'about')}
        ${row('Date of birth', esc(f.birthDate), 'about')}
        ${row('SSN', esc(maskSsn(f.ssn)), 'about')}
        ${row('Mobile', esc(fmtPhone(f.phone)), 'contact')}
        ${row('Email', esc(f.email), 'contact')}
        ${row('Address', esc([f.addressLine1, f.addressLine2, `${f.city}, ${f.state} ${f.postalCode}`].filter(Boolean).join(', ')), 'address')}
      </dl>
      <label class="check"><input type="checkbox" data-consent="certify" ${state.consent.certify ? 'checked' : ''}><span>I certify this information is true and I am applying for myself.</span></label>
      ${nav('address', 'Submit application', 'submit', state.consent.certify ? '' : 'Tick the box to submit.')}`;
  };

  VIEWS.processing = () => `<div class="card-head">
      <div class="eyebrow">One moment</div>
      <h1>Checking your information.</h1>
      <p class="lede">This usually takes a few seconds. Please keep this page open.</p>
    </div>
    <ul class="proc" id="proc">
      <li data-p="0"><span class="dot"></span>Sending your application securely</li>
      <li data-p="1"><span class="dot"></span>Verifying your identity</li>
      <li data-p="2"><span class="dot"></span>Checking for signs of fraud</li>
      <li data-p="3"><span class="dot"></span>Preparing your decision</li>
    </ul>`;

  const refLine = () => (state.app && state.app.applicationId ? `<p class="muted">Reference <span class="ref">${esc(state.app.applicationId)}</span></p>` : '');

  VIEWS.approved = () => `<div class="outcome-band band-good"><span class="eyebrow">Approved</span>
      <h1>Welcome to Russ Community Credit Union, ${esc(state.form.firstName || 'member')}.</h1></div>
    <p class="lede">Your membership and accounts are open. Here is what happens next.</p>
    <ol class="next">
      <li><div><h3>Fund your account</h3><p class="muted">Move money in from another bank, or deposit at any branch.</p></div></li>
      <li><div><h3>Set up digital banking</h3><p class="muted">Create your sign-in to see balances and pay bills.</p></div></li>
      <li><div><h3>Watch for your debit card</h3><p class="muted">It arrives by mail in 7 to 10 business days.</p></div></li>
    </ol>
    ${refLine()}
    <div class="actions"><span></span><div class="actions-right"><button type="button" class="btn btn-outline" data-action="restart">Start a new application</button></div></div>`;

  VIEWS.denied = () => `<div class="outcome-band band-bad"><span class="eyebrow">Decision</span>
      <h1>We can't open this account online.</h1></div>
    <p class="lede">We were not able to approve your application today. This decision was based on information from identity and fraud prevention services.</p>
    <div class="panel"><div class="eyebrow">What you can do</div>
      <ul class="need">
        <li>${CHECK}<span>You will receive a notice by mail explaining the reasons and your rights.</span></li>
        <li>${CHECK}<span>Visit a branch with a photo ID and we will review your application in person.</span></li>
        <li>${CHECK}<span>Call member services at (555) 555-0100, weekdays 8 to 6.</span></li>
      </ul></div>
    ${refLine()}
    <div class="actions"><span></span><div class="actions-right"><button type="button" class="btn btn-outline" data-action="restart">Start a new application</button></div></div>`;

  VIEWS.step_up = () => {
    const live = state.config.mode === 'live';
    const cap = state.capture || {};
    return `<div class="outcome-band band-wait"><span class="eyebrow">One more step</span>
        <h1>Let's confirm it's really you.</h1></div>
      <p class="lede">We need a photo of your ID and a quick selfie. It takes about a minute, and your application picks up right where it left off.</p>
      ${live ? `<div id="sdk-mount"></div>
        <div class="panel" id="sdk-panel"><div class="eyebrow">Secure capture by Alloy</div>
          <p id="sdk-msg">Your photos go straight to our identity verification partner. They are not stored on this device.</p>
          <div><button type="button" class="btn btn-coral" data-action="sdk-start">Verify my identity${TRI}</button></div></div>`
        : `<div class="capture" role="group" aria-label="Simulated document capture">
            <button type="button" class="tile" data-capture="id" aria-pressed="${!!cap.id}"><span class="pill ${cap.id ? 'pill-good' : ''}">${cap.id ? 'Captured' : 'Step 1'}</span><h3>Photo ID</h3><span class="muted">Driver's license or passport</span></button>
            <button type="button" class="tile" data-capture="selfie" aria-pressed="${!!cap.selfie}"><span class="pill ${cap.selfie ? 'pill-good' : ''}">${cap.selfie ? 'Captured' : 'Step 2'}</span><h3>Selfie</h3><span class="muted">A quick photo of your face</span></button>
          </div>
          <p class="help">Mock mode: tap each tile to simulate a capture. In live mode, Alloy's SDK opens here.</p>
          <div class="actions"><span></span><div class="actions-right"><button type="button" class="btn btn-coral" data-action="mock-docs" ${cap.id && cap.selfie ? '' : 'disabled'}>Submit photos${TRI}</button></div></div>`}
      ${refLine()}
      <div class="actions"><button type="button" class="link-btn" data-action="save-later">Finish later, or continue in a branch</button><span></span></div>`;
  };

  VIEWS.review_wait = () => `<div class="outcome-band band-info"><span class="eyebrow">In review</span>
      <h1>Thanks, ${esc(state.form.firstName || 'there')}. A specialist is taking a look.</h1></div>
    <p class="lede">Most reviews finish within one business day. You do not need to do anything right now.</p>
    <ol class="next">
      <li><div><h3>We review your application</h3><p class="muted">A member of our team checks the details you provided.</p></div></li>
      <li><div><h3>We contact you with a decision</h3><p class="muted">By text and email, at the contact details you gave us.</p></div></li>
      <li><div><h3>Check any time</h3><p class="muted">Use your reference below on the status page, at a branch, or by phone.</p></div></li>
    </ol>
    ${refLine()}
    <div class="actions"><span id="poll-note" class="help">Checking for a decision every few seconds.</span>
      <div class="actions-right"><button type="button" class="btn btn-outline" data-action="poll-now">Check now</button></div></div>`;

  VIEWS.more_info = () => `<div class="outcome-band band-wait"><span class="eyebrow">A little more needed</span>
      <h1>We need one more detail to continue.</h1></div>
    <p class="lede">Your application is saved. A team member will contact you about the missing information, or you can call (555) 555-0100.</p>
    ${refLine()}
    <div class="actions"><span></span><div class="actions-right"><button type="button" class="btn btn-outline" data-action="poll-now">Check status</button></div></div>`;

  VIEWS.expired = () => `<div class="outcome-band band-bad"><span class="eyebrow">Time ran out</span>
      <h1>Your identity check has expired.</h1></div>
    <p class="lede">For your security, the photo step is only open for a limited time. Your details are not lost. Start again online, or bring your ID to any branch.</p>
    ${refLine()}
    <div class="actions"><span></span><div class="actions-right"><button type="button" class="btn btn-fill" data-action="restart">Start again${TRI}</button></div></div>`;

  VIEWS.error = () => `<div class="outcome-band band-bad"><span class="eyebrow">Something went wrong</span>
      <h1>We couldn't finish your application just now.</h1></div>
    <p class="lede">This is a problem on our side, not with your information. Nothing you entered has been lost.</p>
    ${state.app && state.app.error ? `<div class="panel"><div class="eyebrow">Technical detail</div><p class="ref">${esc(state.app.error)}</p></div>` : ''}
    <div class="actions"><button type="button" class="btn btn-outline" data-go="review">Back to review</button>
      <div class="actions-right"><button type="button" class="btn btn-fill" data-action="submit">Try again${TRI}</button></div></div>`;

  VIEWS.status = () => `<div class="card-head">
      <div class="eyebrow">Application status</div>
      <h1>Check on an application.</h1>
      <p class="lede">Enter the reference from your confirmation. It starts with JA.</p>
    </div>
    <div class="grid"><div class="field full"><label for="lookup">Application reference</label>
      <input class="input" id="lookup" value="${esc(state.lookup || '')}" placeholder="JA-" autocomplete="off" aria-describedby="lookup-err">
      <div class="err" id="lookup-err" role="alert">${esc(state.lookupError)}</div></div></div>
    <div class="actions"><button type="button" class="btn btn-outline" data-go="route">Back to start</button>
      <div class="actions-right"><button type="button" class="btn btn-fill" data-action="lookup">Check status${TRI}</button></div></div>`;

  const OUTCOME_VIEW = { approved: 'approved', denied: 'denied', step_up: 'step_up', review: 'review_wait', more_info: 'more_info', error: 'error', expired: 'expired', processing: 'review_wait' };

  // ------------------------------------------------------------ render
  function render(focusFirstError) {
    const v = state.view;
    $('#view').innerHTML = VIEWS[v]();
    const stepIdx = STEPS.findIndex((s) => s.id === v);
    const prog = $('#progress');
    if (stepIdx >= 0) {
      prog.hidden = false;
      $('#progress-label').textContent = `${stepIdx + 1} of ${STEPS.length}: ${STEPS[stepIdx].label}`;
      $('#progress-time').textContent = STEPS[stepIdx].left;
      $('#steps').innerHTML = STEPS.map((s, i) => `<li class="${i < stepIdx ? 'done' : i === stepIdx ? 'now' : ''}" ${i === stepIdx ? 'aria-current="step"' : ''}><span>${s.label}</span></li>`).join('');
    } else prog.hidden = true;
    if (focusFirstError) { const bad = $('[aria-invalid="true"]'); if (bad) bad.focus(); }
    renderXrayTools();
  }

  function go(view) {
    clearInterval(state.pollTimer);
    state.view = view; state.errors = {};
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('#main').focus({ preventScroll: true });
    if (view === 'review_wait') startPolling();
  }

  // ------------------------------------------------------------ X-ray
  const LANE_NAMES = { applicant: 'Applicant', app: 'Digital app', esb: 'ESB', alloy: 'Alloy', analyst: 'Analyst' };
  let hopQueue = Promise.resolve();

  function json(obj) {
    return esc(JSON.stringify(obj, null, 2))
      .replace(/&quot;([^&]+?)&quot;:/g, '<span class="k">&quot;$1&quot;</span>:')
      .replace(/: &quot;(.*?)&quot;/g, ': <span class="s">&quot;$1&quot;</span>')
      .replace(/: (-?\d+(\.\d+)?|true|false|null)/g, ': <span class="n">$1</span>');
  }

  function hopHtml(h) {
    const mapped = h.mapped ? `<div class="mapped">${h.mapped.status !== undefined ? `<span class="tag">status: ${esc(h.mapped.status)}</span>` : ''}${h.mapped.complete_outcome !== undefined ? `<span class="tag">complete_outcome: ${esc(h.mapped.complete_outcome)}</span>` : ''}${h.mapped.experience || h.mapped.state ? `<span class="tag exp">experience: ${esc(h.mapped.experience || h.mapped.state)}</span>` : ''}</div>` : '';
    return `<li class="hop">
      <div class="hop-route"><b>${LANE_NAMES[h.from] || h.from}</b><svg class="arrow" viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0 10 6 0 12Z"/></svg><b>${LANE_NAMES[h.to] || h.to}</b></div>
      <div class="hop-title">${esc(h.title)}</div>
      ${h.method || h.httpStatus !== undefined ? `<div class="hop-line">${h.method ? `<span class="tag">${esc(h.method)}</span>` : ''}${h.url ? `<span class="tag">${esc(h.url)}</span>` : ''}${h.httpStatus !== undefined ? `<span class="tag">HTTP ${esc(h.httpStatus)}</span>` : ''}${h.ms ? `<span class="tag">${esc(h.ms)} ms</span>` : ''}</div>` : ''}
      ${h.auth ? `<div class="hop-note">Auth: ${esc(h.auth)}</div>` : ''}
      ${h.note ? `<div class="hop-note">${esc(h.note)}</div>` : ''}
      ${mapped}
      ${h.request ? `<details><summary>Request body</summary><pre>${json(h.request)}</pre></details>` : ''}
      ${h.response ? `<details><summary>Response body</summary><pre>${json(h.response)}</pre></details>` : ''}
    </li>`;
  }

  /** Reveal hops one at a time so the audience can follow the request across the lanes. */
  function addHops(hops) {
    if (!hops || !hops.length) return hopQueue;
    $('#xray-empty').hidden = true;
    for (const h of hops) {
      hopQueue = hopQueue.then(() => new Promise((resolve) => {
        $$('.lane').forEach((l) => l.classList.toggle('on', l.dataset.lane === h.from || l.dataset.lane === h.to));
        $('#hops').insertAdjacentHTML('beforeend', hopHtml(h));
        const x = $('#xray'); if (!x.hidden) x.scrollTo({ top: x.scrollHeight, behavior: 'smooth' });
        setTimeout(resolve, 420);
      }));
    }
    return hopQueue;
  }

  function localHop(from, to, title, extra) { return addHops([Object.assign({ from, to, title }, extra || {})]); }

  function renderXrayMeta() {
    const c = state.config, r = state.route;
    const built = r.member !== 'existing' && r.product !== 'loan' && r.owner !== 'business' && r.residency !== 'nonresident';
    const journey = built ? `${c.journeyName || 'Consumer Onboarding'} (${c.journeyToken || ''})`
      : r.member === 'existing' ? 'Existing member journey (not built)' : r.product === 'loan' ? 'Lending journey (not built)' : r.owner === 'business' ? 'Business onboarding journey (not built)' : 'Non-resident journey (not built)';
    $('#xray-meta').innerHTML = `<span class="tag">${c.mode === 'live' ? 'LIVE: ' + esc(c.alloyHost || '') : 'MOCK: simulated Alloy responses'}</span><span class="tag">Journey: ${esc(journey)}</span>`;
  }

  function renderXrayTools() {
    const el = $('#xray-tools'); if (!el) return;
    const a = state.app;
    if (state.view === 'review_wait' && a) {
      el.hidden = false;
      el.innerHTML = state.config.mode === 'mock'
        ? `<div class="eyebrow">Analyst decision (mock)</div><p>In live mode an analyst decides this in the Alloy dashboard. Simulate that decision here.</p>
           <div class="row"><button type="button" class="btn btn-sm" data-action="mock-approve">Approve</button><button type="button" class="btn btn-sm" data-action="mock-deny">Deny</button></div>`
        : `<div class="eyebrow">Presenter note</div><p>Open this application in the Alloy dashboard (Applications queue) and approve or deny it. This page updates on its next status check.</p>`;
    } else { el.hidden = true; el.innerHTML = ''; }
  }

  function setXray(open) {
    $('#xray').hidden = !open;
    $('#shell').classList.toggle('with-xray', open);
    $('#xray-toggle').setAttribute('aria-expanded', String(open));
    try { localStorage.setItem('rccu-xray', open ? '1' : '0'); } catch (e) { /* optional */ }
  }

  // ------------------------------------------------------------ API
  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch (e) { data = { error: 'The service returned an unreadable response.' }; }
    if (!res.ok && !data.state) data.state = 'error';
    return data;
  }

  function applyResult(data) {
    state.app = Object.assign({}, state.app, data);
    if (data.applicationId) { try { localStorage.setItem('rccu-last-ref', data.applicationId); } catch (e) { /* optional */ } }
    return addHops(data.trace).then(() => {
      const target = OUTCOME_VIEW[data.state] || 'error';
      if (state.view !== target) go(target); else { render(); if (target === 'review_wait') startPolling(); }
    });
  }

  async function submit() {
    state.app = null; state.capture = {};
    go('processing');
    const marks = $$('#proc li'); let i = 0;
    const tick = () => { marks.forEach((m, n) => { m.classList.toggle('ok', n < i); m.classList.toggle('on', n === i); }); };
    tick();
    const timer = setInterval(() => { if (i < marks.length - 1) { i++; tick(); } }, 700);
    localHop('applicant', 'app', 'Applicant submits the application', { note: 'Form validated in the browser. SSN masked on screen.' });
    const started = Date.now();
    let data;
    try { data = await api('POST', '/api/applications', state.form); }
    catch (e) { data = { state: 'error', error: 'Could not reach the credit union service. Is the server running?' }; }
    const wait = Math.max(0, 2400 - (Date.now() - started));
    setTimeout(() => { clearInterval(timer); i = marks.length; tick(); applyResult(data); }, wait);
  }

  async function poll(showBusy) {
    if (!state.app || !state.app.applicationId) return;
    const note = $('#poll-note'); if (note && showBusy) note.textContent = 'Checking now.';
    let data;
    try { data = await api('GET', '/api/applications/' + encodeURIComponent(state.app.applicationId)); }
    catch (e) { if (note) note.textContent = 'Could not check just now. We will try again.'; return; }
    const changed = data.state && data.state !== state.app.state;
    if (changed || showBusy) await applyResult(showBusy || changed ? data : Object.assign({}, data, { trace: [] }));
    else state.app = Object.assign({}, state.app, data, { trace: undefined });
    const n2 = $('#poll-note'); if (n2) n2.textContent = `Last checked ${new Date().toLocaleTimeString()}. Still in review.`;
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    let n = 0;
    state.pollTimer = setInterval(() => { n++; if (n > 60 || state.view !== 'review_wait') return clearInterval(state.pollTimer); poll(false); }, 6000);
  }

  async function mockAdvance(action) {
    if (!state.app) return;
    const data = await api('POST', `/api/mock/applications/${encodeURIComponent(state.app.applicationId)}/advance`, { action });
    if (data.error && !data.state) return;
    await applyResult(data);
  }

  // ------------------------------------------------------------ Alloy SDK (live step-up)
  function loadSdk() {
    return new Promise((resolve, reject) => {
      if (window.alloy) return resolve();
      const s = document.createElement('script');
      s.src = 'https://scripts.alloy.com/2/16/alloy_sdk_bundle.js';
      s.onload = () => (window.alloy ? resolve() : reject(new Error('The Alloy SDK loaded but did not start.')));
      s.onerror = () => reject(new Error('The Alloy SDK could not be loaded.'));
      document.head.appendChild(s);
    });
  }

  async function startSdk() {
    const msg = $('#sdk-msg');
    const c = state.config;
    if (!c.sdkKey) { msg.textContent = 'No SDK key is set. Add ALLOY_SDK_KEY to the .env file and restart the server.'; return; }
    msg.textContent = 'Opening secure capture.';
    localHop('app', 'alloy', 'App opens the Alloy SDK for document capture', { method: 'SDK', url: 'alloy.init({ key, journeyToken, journeyApplicationToken }) then alloy.open()', note: 'Images go from the browser straight to Alloy. They never pass through the ESB.' });
    try {
      await loadSdk();
      await window.alloy.init({ key: c.sdkKey, journeyToken: c.journeyToken, journeyApplicationToken: state.app.applicationId, production: false });
      window.alloy.open((result) => {
        localHop('alloy', 'app', 'Alloy SDK closed', { response: result || {} });
        msg.textContent = 'Thanks. Checking your result.';
        poll(true);
      }, 'sdk-mount');
    } catch (e) {
      msg.textContent = `Secure capture could not start: ${e.message} You can finish at a branch, or check status later.`;
      localHop('app', 'alloy', 'Alloy SDK failed to start', { note: e.message });
    }
  }

  // ------------------------------------------------------------ events
  function randomSsn() {
    let ssn;
    do {
      ssn = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    } while (ssn.startsWith('000') || ssn.startsWith('666') || ssn.startsWith('9'));
    return ssn;
  }

  function randomPhone() {
    return '402555' + String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  }

  function randomEmail(first, last) {
    const tag = Math.random().toString(36).slice(2, 8);
    return `${first}.${last}.${tag}@example.com`.toLowerCase();
  }

  function fillPersona(key) {
    const p = PERSONAS.find((x) => x.key === key); if (!p) return;
    Object.assign(state.form, {
      firstName: p.first, lastName: p.last, birthDate: '1988-04-12', ssn: randomSsn(),
      email: randomEmail(p.first, p.last), phone: randomPhone(),
      addressLine1: '100 Main Street', addressLine2: '', city: 'Anytown', state: 'FL', postalCode: p.postal, mailingSame: true,
    });
    state.errors = {};
    render();
  }

  function restart() {
    clearInterval(state.pollTimer);
    Object.assign(state, { app: null, capture: {}, errors: {}, showSsn: false });
    state.route = { member: null, product: null, owner: null, residency: null };
    state.consent = { notice: false, esign: false, marketing: false, certify: false };
    Object.keys(state.form).forEach((k) => { state.form[k] = k === 'mailingSame' ? true : ''; });
    $('#hops').innerHTML = ''; $('#xray-empty').hidden = false; $$('.lane').forEach((l) => l.classList.remove('on'));
    renderXrayMeta();
    go('route');
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-go],[data-action],[data-route],[data-persona],[data-capture]');
    if (!t) return;
    if (t.dataset.go) return go(t.dataset.go);
    if (t.dataset.persona) return fillPersona(t.dataset.persona);
    if (t.dataset.capture) { state.capture = Object.assign({}, state.capture, { [t.dataset.capture]: true }); return render(); }
    if (t.dataset.route) {
      const order = ['member', 'product', 'owner', 'residency'], k = t.dataset.route;
      state.route[k] = t.dataset.value;
      render(); renderXrayMeta();
      const next = order[order.indexOf(k) + 1];
      const el = next && $(`[data-route="${next}"]`); if (el && !state.route[next]) el.focus();
      return;
    }
    const a = t.dataset.action;
    if (a === 'route-next') {
      const r = state.route;
      if (!(r.member && r.product && r.owner && r.residency)) return render();
      const built = r.member === 'new' && r.product === 'deposit' && r.owner === 'personal' && r.residency === 'resident';
      return go(built ? 'welcome' : 'otherPath');
    }
    if (a === 'use-built-path') { state.route = { member: 'new', product: 'deposit', owner: 'personal', residency: 'resident' }; renderXrayMeta(); return go('welcome'); }
    if (a === 'welcome-next') { if (state.consent.notice && state.consent.esign) return go('contact'); return render(); }
    if (a && a.startsWith('next:')) {
      const errs = check(VIEW_FIELDS[state.view] || []);
      if (Object.keys(errs).length) {
        state.errors = errs; render(true);
        const hint = $('.hint-missing'); if (hint) hint.textContent = 'Still needed: ' + Object.keys(errs).map((k) => FIELD_NAMES[k]).join(', ') + '.';
        return;
      }
      return go(a.split(':')[1]);
    }
    if (a === 'submit') {
      const errs = check([].concat(VIEW_FIELDS.contact, VIEW_FIELDS.about, VIEW_FIELDS.address));
      if (Object.keys(errs).length) { const first = Object.keys(errs)[0]; const view = Object.keys(VIEW_FIELDS).find((v) => VIEW_FIELDS[v].includes(first)); state.view = view; state.errors = errs; return render(true); }
      if (!state.consent.certify) return render();
      return submit();
    }
    if (a === 'toggle-ssn') { state.showSsn = !state.showSsn; return render(); }
    if (a === 'restart') return restart();
    if (a === 'poll-now') return poll(true);
    if (a === 'mock-docs') return mockAdvance('documents_submitted');
    if (a === 'mock-approve') return mockAdvance('review_approved');
    if (a === 'mock-deny') return mockAdvance('review_denied');
    if (a === 'sdk-start') return startSdk();
    if (a === 'save-later') { state.lookup = state.app ? state.app.applicationId : ''; return go('status'); }
    if (a === 'lookup') {
      const ref = ($('#lookup').value || '').trim(); state.lookup = ref;
      if (!/^JA-[A-Za-z0-9_-]{6,40}$/.test(ref)) { state.lookupError = 'Enter a reference that starts with JA-.'; return render(); }
      state.lookupError = ''; state.app = { applicationId: ref };
      return api('GET', '/api/applications/' + encodeURIComponent(ref)).then((data) => {
        if (data.state === 'error') { state.lookupError = data.error || 'We could not find that application.'; addHops(data.trace); return render(); }
        return applyResult(data);
      });
    }
  });

  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset.field) {
      const k = t.dataset.field;
      if (k === 'phone') { t.value = fmtPhone(t.value); state.form.phone = digits(t.value); }
      else if (k === 'ssn') {
        t.value = fmtSsn(t.value); state.form.ssn = digits(t.value);
      }
      else if (k === 'postalCode') { t.value = digits(t.value).slice(0, 5); state.form.postalCode = t.value; }
      else state.form[k] = t.value;
      if (state.errors[k]) { delete state.errors[k]; t.removeAttribute('aria-invalid'); const e = $('#e-' + k); if (e) e.textContent = ''; }
    }
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.consent) { state.consent[t.dataset.consent] = t.checked; const h = $('.hint-missing'); if (h) h.textContent = ''; }
    if (t.dataset.formCheck) state.form[t.dataset.formCheck] = t.checked;
    if (t.dataset.field && t.tagName === 'SELECT') state.form[t.dataset.field] = t.value;
  });

  document.addEventListener('focusout', (ev) => {
    const t = ev.target;
    if (!t.dataset || !t.dataset.field || !RULES[t.dataset.field]) return;
    const k = t.dataset.field;
    if (!String(state.form[k] || '').trim()) return; // only nag about fields the applicant has started
    const m = RULES[k](state.form);
    const e = $('#e-' + k);
    if (m) { state.errors[k] = m; t.setAttribute('aria-invalid', 'true'); if (e) e.textContent = m; }
    if (k === 'ssn' && !m && !state.showSsn) t.value = maskSsn(state.form.ssn);
  });

  document.addEventListener('focusin', (ev) => {
    const t = ev.target;
    if (t.dataset && t.dataset.field === 'ssn' && !state.showSsn && t.value.includes('*')) t.value = fmtSsn(state.form.ssn); // show digits while editing
  });

  $('#xray-toggle').addEventListener('click', () => setXray($('#xray').hidden));
  $('#xray-close').addEventListener('click', () => setXray(false));
  $('#status-link').addEventListener('click', () => { try { state.lookup = localStorage.getItem('rccu-last-ref') || ''; } catch (e) { state.lookup = ''; } state.lookupError = ''; go('status'); });

  // ------------------------------------------------------------ start
  (async function init() {
    try { state.config = await api('GET', '/api/config'); } catch (e) { /* keep defaults */ }
    const badge = $('#mode-badge');
    badge.dataset.mode = state.config.mode;
    badge.textContent = state.config.mode === 'live' ? 'Live sandbox' : 'Mock mode';
    badge.title = state.config.mode === 'live' ? 'Decisions come from Alloy\'s sandbox' : 'Decisions are simulated. Add your workflow secret to .env for live calls.';
    renderXrayMeta();
    let open = window.matchMedia('(min-width: 1021px)').matches;
    try { const saved = localStorage.getItem('rccu-xray'); if (saved !== null) open = saved === '1'; } catch (e) { /* optional */ }
    setXray(open);
    render();
  })();
})();
