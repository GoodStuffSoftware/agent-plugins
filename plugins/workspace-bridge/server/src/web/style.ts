// The shared stylesheet of every owner page. Everything a theme may change is a CSS custom
// property declared on `:root` (prefix `--wb-`); the rules below only read them. A theme is CSS
// appended after this sheet (see theme.ts and docs/SELF-HOSTING.md, "Theming"), so it overrides
// the properties, and may add rules of its own. Brand-neutral on purpose: no names, logos or art.

/** Default values of every theme property: light, then dark by `prefers-color-scheme`. */
const TOKENS = `
:root{
color-scheme:light dark;
--wb-font-body:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
--wb-font-heading:var(--wb-font-body);
--wb-font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--wb-font-size:1rem;
--wb-line-height:1.55;
--wb-bg:#f4f6f9;
--wb-page-bg:var(--wb-bg);
--wb-surface:#ffffff;
--wb-surface-2:#eef1f5;
--wb-text:#1a1f27;
--wb-text-muted:#566170;
--wb-border:#d8dde5;
--wb-border-strong:#b4bcc8;
--wb-accent:#2b5cc7;
--wb-accent-text:#ffffff;
--wb-accent-soft:#e6edfb;
--wb-link:var(--wb-accent);
--wb-focus:#2b5cc7;
--wb-approve:#177245;
--wb-approve-text:#ffffff;
--wb-approve-soft:#e4f4ea;
--wb-reject:#b42318;
--wb-reject-text:#ffffff;
--wb-reject-soft:#fdeae8;
--wb-warn:#8a5a00;
--wb-warn-soft:#fff3d4;
--wb-warn-border:#e8c768;
--wb-code-bg:#eef1f5;
--wb-header-bg:var(--wb-surface);
--wb-header-text:var(--wb-text);
--wb-header-border:var(--wb-border);
--wb-logo-height:1.75rem;
--wb-radius-sm:.375rem;
--wb-radius:.75rem;
--wb-radius-lg:1rem;
--wb-radius-button:.625rem;
--wb-space-xs:.25rem;
--wb-space-s:.5rem;
--wb-space-m:1rem;
--wb-space-l:1.5rem;
--wb-space-xl:2.5rem;
--wb-content-width:46rem;
--wb-tap:2.75rem;
--wb-shadow-card:0 1px 2px rgba(16,24,40,.06),0 1px 3px rgba(16,24,40,.08);
--wb-shadow-button:0 1px 2px rgba(16,24,40,.08);
}
@media (prefers-color-scheme:dark){:root{
--wb-bg:#11151b;
--wb-surface:#1a2029;
--wb-surface-2:#232a35;
--wb-text:#e8ecf1;
--wb-text-muted:#9ba6b4;
--wb-border:#2d3541;
--wb-border-strong:#46505f;
--wb-accent:#8db3ff;
--wb-accent-text:#0b1a38;
--wb-accent-soft:#1c2a47;
--wb-focus:#8db3ff;
--wb-approve:#46bd80;
--wb-approve-text:#06210f;
--wb-approve-soft:#12301f;
--wb-reject:#f0746a;
--wb-reject-text:#2b0805;
--wb-reject-soft:#3a1714;
--wb-warn:#f0cd7e;
--wb-warn-soft:#352b10;
--wb-warn-border:#6d5a22;
--wb-code-bg:#232a35;
--wb-shadow-card:0 1px 2px rgba(0,0,0,.4);
--wb-shadow-button:0 1px 2px rgba(0,0,0,.4);
}}
`;

const RULES = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;font-family:var(--wb-font-body);font-size:var(--wb-font-size);line-height:var(--wb-line-height);color:var(--wb-text);background:var(--wb-bg);background:var(--wb-page-bg)}
a{color:var(--wb-link);text-underline-offset:.15em}
.site-header{background:var(--wb-header-bg);color:var(--wb-header-text);border-bottom:1px solid var(--wb-header-border)}
.site-header-inner{max-width:var(--wb-content-width);margin:0 auto;padding:var(--wb-space-s) var(--wb-space-m);display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--wb-space-xs) var(--wb-space-m);min-height:3.25rem}
.brand{display:inline-flex;align-items:center;gap:var(--wb-space-s);color:inherit;text-decoration:none;font-family:var(--wb-font-heading);font-weight:700;font-size:1.1rem;letter-spacing:.01em}
.brand-logo{display:block;height:var(--wb-logo-height);width:auto;max-width:12rem}
.brand-mark{width:.7rem;height:.7rem;border-radius:50%;background:var(--wb-accent)}
.site-nav{display:flex;gap:var(--wb-space-xs)}
.site-nav a{display:inline-flex;align-items:center;min-height:var(--wb-tap);padding:0 .75rem;border-radius:var(--wb-radius-button);color:var(--wb-header-text);text-decoration:none;font-weight:500}
.site-nav a:hover{background:var(--wb-surface-2)}
.site-nav a[aria-current="page"]{background:var(--wb-accent-soft);color:var(--wb-accent);font-weight:600}
main{max-width:var(--wb-content-width);margin:0 auto;padding:var(--wb-space-l) var(--wb-space-m) var(--wb-space-xl)}
h1,h2,h3{font-family:var(--wb-font-heading);line-height:1.25;margin:0}
h1{font-size:1.65rem;margin-bottom:var(--wb-space-m)}
h2{font-size:1.2rem;margin:var(--wb-space-l) 0 var(--wb-space-s)}
h3{font-size:1.02rem;margin:var(--wb-space-m) 0 var(--wb-space-s)}
p,ul,ol,dl,table,pre,fieldset{margin:0 0 var(--wb-space-m)}
ul,ol{padding-left:1.25rem}
code,pre{font-family:var(--wb-font-mono);font-size:.88em}
code{background:var(--wb-code-bg);padding:.05em .35em;border-radius:var(--wb-radius-sm);overflow-wrap:anywhere}
pre{background:var(--wb-code-bg);padding:var(--wb-space-m);border-radius:var(--wb-radius);overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
small{color:var(--wb-text-muted)}
.muted{color:var(--wb-text-muted)}
.card{background:var(--wb-surface);border:1px solid var(--wb-border);border-radius:var(--wb-radius);box-shadow:var(--wb-shadow-card);padding:var(--wb-space-m);margin:0 0 var(--wb-space-m)}
.card>:last-child{margin-bottom:0}
.card>h2:first-child,.card>h3:first-child{margin-top:0}
.callout{background:var(--wb-warn-soft);color:var(--wb-text);border:1px solid var(--wb-warn-border);border-left:.3rem solid var(--wb-warn);border-radius:var(--wb-radius);padding:var(--wb-space-s) var(--wb-space-m);margin:0 0 var(--wb-space-m)}
.callout strong:first-child{color:var(--wb-warn)}
.callout-info{background:var(--wb-accent-soft);border-color:var(--wb-border);border-left-color:var(--wb-accent)}
.callout-info strong:first-child{color:var(--wb-accent)}
form{margin:0}
.inline-form{display:inline}
input,select,textarea{font:inherit;color:var(--wb-text);background:var(--wb-surface);border:1px solid var(--wb-border-strong);border-radius:var(--wb-radius-button);min-height:var(--wb-tap);padding:0 .75rem;max-width:100%}
input[type=checkbox]{min-height:0;width:1.35rem;height:1.35rem;margin:0;accent-color:var(--wb-accent);flex:none}
input[type=hidden]{display:none}
label{display:inline-block}
fieldset{border:1px solid var(--wb-border);border-radius:var(--wb-radius);padding:var(--wb-space-s) var(--wb-space-m)}
legend{padding:0 var(--wb-space-xs);font-weight:600}
fieldset ul,.checks{list-style:none;padding:0}
.checks li,fieldset li{margin:0}
.checks label,fieldset li label{display:flex;align-items:center;gap:.75rem;min-height:var(--wb-tap);padding:.15rem 0;width:100%}
:focus-visible{outline:3px solid var(--wb-focus);outline-offset:2px}
button{font:inherit;font-weight:600;color:var(--wb-text);background:var(--wb-surface);border:1px solid var(--wb-border-strong);border-radius:var(--wb-radius-button);min-height:var(--wb-tap);padding:0 1.1rem;cursor:pointer;box-shadow:var(--wb-shadow-button);touch-action:manipulation}
button:hover{background:var(--wb-surface-2)}
button:active{transform:translateY(1px)}
button.primary{background:var(--wb-accent);color:var(--wb-accent-text);border-color:var(--wb-accent)}
button.primary:hover{background:var(--wb-accent);filter:brightness(1.08)}
button.danger{color:var(--wb-reject);border-color:var(--wb-reject);background:var(--wb-surface)}
button.danger:hover{background:var(--wb-reject-soft)}
.btn-approve,.btn-approve-alt,.btn-approve-domain,.btn-reject{display:flex;align-items:center;justify-content:center;gap:.6rem;width:100%;text-align:center;line-height:1.25}
.btn-approve::before,.btn-approve-alt::before{content:"\\2713" / "";font-size:1.15em}
.btn-reject::before{content:"\\2715" / "";font-size:1.05em}
.btn-approve{min-height:3.75rem;font-size:1.15rem;background:var(--wb-approve);color:var(--wb-approve-text);border-color:var(--wb-approve)}
.btn-approve:hover{background:var(--wb-approve);filter:brightness(1.08)}
.btn-approve-alt{min-height:3.25rem;background:var(--wb-approve-soft);color:var(--wb-approve);border:2px solid var(--wb-approve);overflow-wrap:anywhere}
.btn-approve-alt:hover{background:var(--wb-approve-soft);filter:brightness(.96)}
.btn-approve-domain{min-height:var(--wb-tap);font-weight:500;background:var(--wb-surface);border-width:1px;box-shadow:none}
.btn-reject{min-height:3.25rem;background:var(--wb-reject);color:var(--wb-reject-text);border-color:var(--wb-reject)}
.btn-reject:hover{background:var(--wb-reject);filter:brightness(1.08)}
.decision{margin-top:var(--wb-space-m)}
.decision h2{margin-top:0}
.decision-group{display:grid;gap:var(--wb-space-s);margin:0 0 var(--wb-space-m)}
.decision-group>p{margin:0}
.decision-reject{border-top:1px dashed var(--wb-border-strong);padding-top:var(--wb-space-m);margin:var(--wb-space-l) 0 0}
.decision-note{color:var(--wb-text-muted);font-size:.92rem;margin:var(--wb-space-m) 0 0}
.facts{display:grid;gap:0;margin:0}
.facts dt{font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--wb-text-muted);margin:var(--wb-space-s) 0 0}
.facts dt:first-child{margin-top:0}
.facts dd{margin:0 0 var(--wb-space-s);padding-bottom:var(--wb-space-s);border-bottom:1px solid var(--wb-border);overflow-wrap:anywhere;font-size:1.05rem}
.facts dd:last-child{border-bottom:0;padding-bottom:0;margin-bottom:0}
.facts dd.subject{font-weight:600}
.facts dd ul{margin:0;padding:0;list-style:none}
.facts-small dd{font-size:.95rem}
.pill{display:inline-block;padding:.05rem .6rem;border-radius:999px;background:var(--wb-surface-2);border:1px solid var(--wb-border);font-size:.9rem}
details.card>summary{cursor:pointer;font-weight:600;min-height:var(--wb-tap);display:flex;align-items:center}
details.card[open]>summary{margin-bottom:var(--wb-space-s)}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th{text-align:left;font-size:.78rem;letter-spacing:.05em;text-transform:uppercase;color:var(--wb-text-muted)}
th,td{padding:.6rem .7rem;border-bottom:1px solid var(--wb-border);vertical-align:top;overflow-wrap:anywhere}
td ul{list-style:none;padding:0;margin:0}
td li{margin:0 0 var(--wb-space-xs)}
td form.inline-form{margin:.25rem .75rem .25rem 0}
td input{min-height:var(--wb-tap)}
.audit-table{font-size:.9rem}
.actions-row{display:flex;flex-wrap:wrap;gap:var(--wb-space-s);align-items:center}
.toolbar-row{display:flex;flex-wrap:wrap;gap:var(--wb-space-s);align-items:center;margin:0 0 var(--wb-space-m)}
.toolbar-row>*{margin:0}
.field-row{display:flex;flex-wrap:wrap;gap:var(--wb-space-s);align-items:center;margin:0 0 var(--wb-space-m)}
.field-row>*{margin:0}
.field-row input[name=value]{flex:1 1 14rem}
.page-intro{color:var(--wb-text-muted);margin:calc(var(--wb-space-s) * -1) 0 var(--wb-space-m)}
@media (max-width:44rem){
.cards-table thead{position:absolute;left:-9999px}
.cards-table,.cards-table tbody,.cards-table tr,.cards-table td{display:block;width:100%}
.cards-table tr{background:var(--wb-surface);border:1px solid var(--wb-border);border-radius:var(--wb-radius);box-shadow:var(--wb-shadow-card);padding:var(--wb-space-s) var(--wb-space-m);margin:0 0 var(--wb-space-m)}
.cards-table td{border:0;padding:.35rem 0}
.cards-table td:empty{display:none}
.cards-table td::before{display:block;font-size:.75rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--wb-text-muted)}
.cards-table td:first-child{font-weight:600}
.cards-table td:first-child input{width:100%;margin:var(--wb-space-xs) 0}
.accounts-table td:nth-child(1)::before{content:"Label"}
.accounts-table td:nth-child(2)::before{content:"Address"}
.accounts-table td:nth-child(3)::before{content:"Provider"}
.accounts-table td:nth-child(4)::before{content:"Components"}
.accounts-table td:nth-child(5)::before{content:"Status"}
.accounts-table td:nth-child(6)::before{content:"Default"}
.accounts-table td:nth-child(7)::before{content:"Actions"}
.allow-table td:nth-child(1)::before{content:"Type"}
.allow-table td:nth-child(2)::before{content:"Allowed"}
.allow-table td:nth-child(3)::before{content:"Added (UTC)"}
.audit-table td:nth-child(1)::before{content:"Time (UTC)"}
.audit-table td:nth-child(2)::before{content:"Account"}
.audit-table td:nth-child(3)::before{content:"Tool"}
.audit-table td:nth-child(4)::before{content:"Result"}
.audit-table td:nth-child(5)::before{content:"From"}
.audit-table td:nth-child(6)::before{content:"To, cc, bcc"}
.audit-table td:nth-child(7)::before{content:"Subject"}
.audit-table td:nth-child(8)::before{content:"Detail"}
.audit-table td:nth-child(9)::before{content:"Client"}
}
@media (min-width:34rem){
.facts{grid-template-columns:7.5rem 1fr;column-gap:var(--wb-space-m)}
.facts dt{margin:0;padding:.3rem 0 0}
.facts dd{margin:0;padding:0 0 var(--wb-space-s);margin-bottom:var(--wb-space-s)}
.facts dt:first-child{margin-top:0}
main{padding-top:var(--wb-space-xl)}
.card{padding:var(--wb-space-l)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

/** The whole base sheet, minified by hand: one line per rule. */
export const BASE_CSS: string = `${TOKENS}${RULES}`;
