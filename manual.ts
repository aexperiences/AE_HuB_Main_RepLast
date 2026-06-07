import { Router } from "express";
import { requireEmployeeAuth } from "../middlewares/authMiddleware";
import PDFDocument from "pdfkit";

const router = Router();

const BRAND = "#4F46E5", DARK = "#111827", GRAY = "#6B7280";
const LGRAY = "#F3F4F6", GREEN = "#059669", AMBER = "#D97706", BLUE = "#2563EB";
const PURPLE = "#7C3AED", SKY = "#0284C7";
const LM = 72, RM = 540, W = 468;

type Doc = InstanceType<typeof PDFDocument>;

function makeDoc() {
  return new PDFDocument({
    size: "LETTER", bufferPages: true,
    margins: { top: 72, bottom: 80, left: 72, right: 72 },
    info: { Title: "AE Hub Manual", Author: "Accelerated Experiences LLC" },
  });
}

function hr(doc: Doc, yPos?: number, color = "#E5E7EB", lw = 0.5) {
  const y = yPos ?? doc.y;
  doc.save().moveTo(LM, y).lineTo(RM, y).strokeColor(color).lineWidth(lw).stroke().restore();
}

function checkPage(doc: Doc, needed = 40) {
  if (doc.y + needed > 720) doc.addPage();
}

function sectionTitle(doc: Doc, num: string, title: string) {
  doc.addPage();
  doc.save().rect(LM, 72, W, 5).fillColor(BRAND).fill().restore();
  doc.fontSize(9).font("Helvetica-Bold").fillColor(BRAND).text(`SECTION ${num}`, LM, 92, { width: W });
  doc.fontSize(22).font("Helvetica-Bold").fillColor(DARK).text(title, LM, doc.y + 2, { width: W });
  const ruleY = doc.y + 8;
  hr(doc, ruleY, BRAND, 1.5);
  doc.y = ruleY + 14;
}

function h2(doc: Doc, text: string) {
  checkPage(doc, 40);
  doc.y += 8;
  doc.fontSize(11).font("Helvetica-Bold").fillColor(BRAND)
    .text(text.toUpperCase(), LM, doc.y, { width: W, characterSpacing: 0.4 });
  doc.y += 2;
  hr(doc, doc.y);
  doc.y += 8;
}

function body(doc: Doc, text: string) {
  checkPage(doc, 30);
  doc.fontSize(10).font("Helvetica").fillColor(GRAY)
    .text(text, LM, doc.y, { width: W, lineGap: 3 });
  doc.y += 8;
}

function bullets(doc: Doc, items: string[]) {
  items.forEach(item => {
    checkPage(doc, 16);
    doc.fontSize(10).font("Helvetica").fillColor(GRAY)
      .text(`\u2022  ${item}`, LM, doc.y, { width: W, indent: 10, lineGap: 2 });
    doc.y += 3;
  });
  doc.y += 6;
}

function twoColRow(doc: Doc, opts: {
  leftText: string; leftX: number; leftW: number; leftFont: string; leftSize: number; leftColor: string;
  rightText: string; rightX: number; rightW: number; rightFont: string; rightSize: number; rightColor: string;
  gap?: number; lineGap?: number;
}) {
  const y = doc.y;
  const { gap = 4, lineGap = 2 } = opts;
  doc.fontSize(opts.leftSize).font(opts.leftFont);
  const leftH = doc.heightOfString(opts.leftText, { width: opts.leftW });
  doc.fontSize(opts.rightSize).font(opts.rightFont);
  const rightH = doc.heightOfString(opts.rightText, { width: opts.rightW });
  const rowH = Math.max(leftH, rightH);
  doc.fontSize(opts.leftSize).font(opts.leftFont).fillColor(opts.leftColor)
    .text(opts.leftText, opts.leftX, y, { width: opts.leftW, lineGap });
  doc.fontSize(opts.rightSize).font(opts.rightFont).fillColor(opts.rightColor)
    .text(opts.rightText, opts.rightX, y, { width: opts.rightW, lineGap });
  doc.y = y + rowH + gap;
}

function steps(doc: Doc, items: string[]) {
  const numColW = 22;
  const textColW = W - numColW - 6;
  items.forEach((text, i) => {
    checkPage(doc, 20);
    twoColRow(doc, {
      leftText: `${i + 1}.`, leftX: LM, leftW: numColW, leftFont: "Helvetica-Bold", leftSize: 10, leftColor: BRAND,
      rightText: text, rightX: LM + numColW + 6, rightW: textColW, rightFont: "Helvetica", rightSize: 10, rightColor: DARK,
      gap: 5, lineGap: 2,
    });
  });
  doc.y += 6;
}

function callout(doc: Doc, type: "tip" | "note" | "admin", text: string) {
  checkPage(doc, 50);
  const cfg = {
    tip:   { color: GREEN,  label: "TIP",        bg: "#F0FDF4" },
    note:  { color: BLUE,   label: "NOTE",       bg: "#EFF6FF" },
    admin: { color: AMBER,  label: "ADMIN ONLY", bg: "#FFFBEB" },
  }[type];
  doc.fontSize(9).font("Helvetica-Bold");
  const labelStr = `${cfg.label}: `;
  const labelPxW = doc.widthOfString(labelStr) + 4;
  const textX = LM + 14 + labelPxW;
  const textW = RM - textX - 4;
  doc.fontSize(9).font("Helvetica");
  const textH = doc.heightOfString(text, { width: textW });
  const boxH = Math.max(textH + 22, 34);
  const boxY = doc.y;
  doc.save()
    .rect(LM, boxY, W, boxH).fillColor(cfg.bg).fill()
    .moveTo(LM, boxY).lineTo(LM, boxY + boxH).strokeColor(cfg.color).lineWidth(3).stroke()
    .restore();
  const textY = boxY + 11;
  doc.fontSize(9).font("Helvetica-Bold").fillColor(cfg.color)
    .text(labelStr, LM + 14, textY, { lineBreak: false, width: labelPxW });
  doc.fontSize(9).font("Helvetica").fillColor(DARK)
    .text(text, textX, textY, { width: textW, lineGap: 2 });
  doc.y = boxY + boxH + 10;
}

function statusRow(doc: Doc, label: string, color: string, desc: string) {
  checkPage(doc, 18);
  const labelColW = 110;
  twoColRow(doc, {
    leftText: `[${label}]`, leftX: LM, leftW: labelColW, leftFont: "Helvetica-Bold", leftSize: 9, leftColor: color,
    rightText: desc, rightX: LM + labelColW, rightW: W - labelColW, rightFont: "Helvetica", rightSize: 9, rightColor: GRAY,
    gap: 3, lineGap: 2,
  });
}

function addPageNumbers(doc: Doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    if (i === 0) continue;
    doc.switchToPage(i);
    doc.fontSize(8).font("Helvetica").fillColor(GRAY)
      .text("AE Hub User Manual  \u00B7  Accelerated Experiences LLC", LM, 754, { width: W / 2 + 30, lineBreak: false });
    doc.text(`Page ${i}`, LM, 754, { width: W, align: "right", lineBreak: false });
  }
}

// ─── EMPLOYEE MANUAL ──────────────────────────────────────────────────────────
function buildEmployeeManual(doc: Doc) {

  // ── Cover ──
  doc.save().rect(0, 0, 612, 792).fillColor(BRAND).fill().restore();
  doc.save().rect(0, 620, 612, 172).fillColor("#312E81").fill().restore();
  doc.save().rect(LM, 80, 56, 56).fillColor("rgba(255,255,255,0.12)").fillOpacity(0.12).fill().restore();
  doc.fontSize(30).font("Helvetica-Bold").fillColor("white").text("AE", LM + 8, 96, { lineBreak: false });
  doc.fontSize(46).font("Helvetica-Bold").fillColor("white").text("AE Hub", LM, 168, { width: W });
  doc.fontSize(21).font("Helvetica").fillColor("rgba(255,255,255,0.72)").text("User Manual", LM, 225, { width: W });
  doc.save().moveTo(LM, 262).lineTo(LM + 180, 262).strokeColor("rgba(255,255,255,0.28)").lineWidth(1).stroke().restore();
  doc.fontSize(11).font("Helvetica").fillColor("rgba(255,255,255,0.56)")
    .text("Complete guide for employees and admins — every feature\nand workflow in AE Hub, including the full revenue pipeline.", LM, 276, { width: W });
  doc.fontSize(9).font("Helvetica").fillColor("rgba(255,255,255,0.38)")
    .text("Accelerated Experiences LLC", LM, 716, { width: W / 2, lineBreak: false });
  doc.text(`Version 2.0  \u00B7  ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
    LM, 716, { width: W, align: "right", lineBreak: false });

  // ── Table of Contents ──
  doc.addPage();
  doc.fontSize(22).font("Helvetica-Bold").fillColor(DARK).text("Table of Contents", LM, 72, { width: W });
  doc.y = 104;
  hr(doc, doc.y, BRAND, 1.5);
  doc.y += 14;

  const tocNumW  = 26;
  const tocTitW  = 186;
  const tocDescX = LM + tocNumW + tocTitW + 6;
  const tocDescW = RM - tocDescX;

  const tocRows: [string, string, string][] = [
    ["01", "Welcome to AE Hub",         "Overview, navigation, and the client vs. internal split"],
    ["02", "Signing In & Accounts",      "Employee login, client portal, password resets"],
    ["03", "Dashboard",                  "Daily KPIs, revenue pipeline, and activity feed"],
    ["04", "Client Projects",            "Creating and managing paid external work"],
    ["05", "My Products",                "Internal apps, podcast, websites, and brands"],
    ["06", "Project Tasks & Kanban",     "Task boards, priorities, and workflow stages"],
    ["07", "Expenses",                   "Tracking and categorizing all business costs"],
    ["08", "Invoices & Payments",        "Billing clients and recording received payments"],
    ["09", "Estimator",                  "Building itemized quotes before work begins"],
    ["10", "Proposals",                  "Sending formal proposals for client acceptance"],
    ["11", "Contracts",                  "Drafting, sending, and collecting signed contracts"],
    ["12", "Deliverables",               "Sharing files and collecting client approvals"],
    ["13", "Client Portal",              "What clients see across all four portal tabs"],
    ["14", "Deadlines",                  "Priority due-date tracking across all projects"],
    ["15", "Time Tracking",              "Logging hours and calculating billable revenue"],
    ["16", "Clients (CRM)",              "Contact and lead management"],
    ["17", "Team",                       "Members, roles, and hourly rates"],
    ["18", "Accounting",                 "Flash report, revenue pipeline, and PM forecasts"],
    ["19", "Reports",                    "P&L, revenue by client, team performance"],
    ["20", "Branding",                   "Customizing the app appearance"],
    ["21", "Admin: Approvals",           "Approving and managing all user accounts"],
    ["22", "Agent Hub",                  "Sharon, Dolly, Geoffrey, and Anetta — your AI team"],
    ["23", "Bobert & Creative Studio",   "AI assistant and on-demand build workspace"],
    ["24", "Automation Department",      "ARIA, APEX, and ORACLE — workflow automation and ROI"],
    ["25", "IT Department",              "NEXUS, CIPHER, and FORGE — system reliability and maintenance"],
    ["26", "Social Media Department",    "VIBE, ECHO, and PRISM — campaigns, copy, and analytics"],
    ["27", "Digital Inventors",          "EINSTEIN, NOVA, VEGA, and LYRA — innovation and product strategy"],
    ["28", "Filing Cabinet & Notes",     "Document storage and the built-in rich-text editor"],
    ["29", "Calendar",                   "Company-wide event and scheduling hub"],
    ["\u2014", "Quick Reference Card",   "Common tasks at a glance"],
  ];

  tocRows.forEach(([num, title, desc]) => {
    checkPage(doc, 24);
    const y = doc.y;
    doc.fontSize(10).font("Helvetica-Bold");
    const numH  = doc.heightOfString(num,   { width: tocNumW });
    const titH  = doc.heightOfString(title, { width: tocTitW });
    doc.fontSize(10).font("Helvetica");
    const descH = doc.heightOfString(desc,  { width: tocDescW });
    const rowH  = Math.max(numH, titH, descH);
    doc.fontSize(10).font("Helvetica-Bold").fillColor(BRAND)
      .text(num, LM, y, { width: tocNumW, lineBreak: false });
    doc.fontSize(10).font("Helvetica-Bold").fillColor(DARK)
      .text(title, LM + tocNumW, y, { width: tocTitW });
    doc.fontSize(10).font("Helvetica").fillColor(GRAY)
      .text(desc, tocDescX, y, { width: tocDescW });
    doc.y = y + rowH + 4;
    hr(doc, doc.y, LGRAY);
    doc.y += 5;
  });

  // ── §01 Welcome ──
  sectionTitle(doc, "01", "Welcome to AE Hub");
  body(doc, "AE Hub is the all-in-one business management system for Accelerated Experiences LLC — client work, internal products, finances, team, and file deliverables in one place, with a secure portal for client approvals.");
  h2(doc, "The Revenue Pipeline");
  body(doc, "AE Hub is built around a single end-to-end revenue flow: Estimate \u2192 Proposal \u2192 Contract \u2192 Project \u2192 Invoice \u2192 Collected. Every tool in the Finance section serves a specific stage of this pipeline. When all stages are used, you have a complete paper trail from first quote to final payment.");
  h2(doc, "The Two Sides of the Business");
  bullets(doc, [
    "CLIENT SIDE — paid work for external clients: Estimates, Proposals, Contracts, Client Projects, Deliverables, Invoices, Client Portal",
    "INTERNAL SIDE — things you own and build yourself: My Products (apps, podcast, websites, social channels)",
  ]);
  h2(doc, "Who Uses AE Hub?");
  bullets(doc, [
    "Owners & Admins — full access plus user approvals and system settings",
    "Employees — projects, tasks, time tracking, deliverables, and their own profile",
    "Clients — a secure portal showing deliverables, proposals, invoices, and contracts shared with their email",
  ]);
  callout(doc, "tip", "Keep AE Hub open all day as your operational command center. It's designed to be checked constantly, not opened once a week.");

  // ── §02 Sign In ──
  sectionTitle(doc, "02", "Signing In & Accounts");
  h2(doc, "Employee Sign-In");
  steps(doc, [
    "Go to the app URL — you'll be redirected to the sign-in page automatically",
    "Enter your company email and password",
    "Click \"Sign In\" — you land on the Dashboard",
  ]);
  callout(doc, "note", "No account yet? Click \"Register\". Your account stays Pending until an Admin approves it from the Approvals page.");
  h2(doc, "Client Sign-In");
  body(doc, "Clients use a completely separate portal at /client on the same URL. They only see content specifically shared with their email — nothing else in the system is visible to them.");
  steps(doc, [
    "Tell the client to visit the app URL and click \"Client portal\" at the bottom of the sign-in screen",
    "Client clicks \"Register\" and enters their name, email, and a password of their choice",
    "Admin approves their account from the Approvals page",
    "Client can now sign in and access their portal immediately",
  ]);
  h2(doc, "Forgotten Password");
  body(doc, "Contact your Admin to have your password reset from the admin panel.");

  // ── §03 Dashboard ──
  sectionTitle(doc, "03", "Dashboard");
  body(doc, "The Dashboard is the first screen after signing in — a real-time snapshot of the business. Make it your first stop every morning.");
  h2(doc, "Summary Cards");
  bullets(doc, [
    "Total Revenue — sum of all Paid invoices to date (real cash received)",
    "Active Projects — client projects currently in Active status",
    "Outstanding Invoices — total dollar value of sent but unpaid invoices",
    "Team Members — count of currently active team members",
  ]);
  h2(doc, "Revenue Pipeline");
  body(doc, "The pipeline strip shows live counts and dollar values across five stages of the revenue flow:");
  bullets(doc, [
    "Proposals \u2014 proposals sent to clients and awaiting a response",
    "Accepted \u2014 proposals the client has formally accepted",
    "Contracted \u2014 signed or executed contracts (signed + executed count)",
    "Invoiced \u2014 outstanding invoices currently awaiting payment",
    "Collected \u2014 invoices paid this month",
  ]);
  h2(doc, "Other Dashboard Panels");
  bullets(doc, [
    "Monthly Revenue Chart — bar chart of Paid invoice totals per month",
    "Upcoming Deadlines — nearest due dates across all active projects and deadline entries",
    "Recent Activity — log of recent system actions: proposals sent, contracts signed, invoices paid, approvals, etc.",
  ]);
  callout(doc, "tip", "If any number looks wrong, click through to that section immediately. Cards always reflect the live database state.");

  // ── §04 Client Projects ──
  sectionTitle(doc, "04", "Client Projects");
  body(doc, "All paid work for external clients — photography, video production, brand work, event coverage, and anything you are being hired to deliver. Completely separate from your internal products.");
  h2(doc, "Creating a Client Project");
  steps(doc, [
    "Click \"Client Projects\" in the sidebar",
    "Click \"New Project\"",
    "Enter the project name, client name, and agreed budget in dollars",
    "Set the initial status — usually \"Active\" for newly contracted work",
    "Click \"Create Project\"",
  ]);
  h2(doc, "Project Statuses");
  statusRow(doc, "Active",    GREEN, "Work is currently in progress");
  statusRow(doc, "On Hold",   AMBER, "Paused — awaiting client feedback or resources");
  statusRow(doc, "Completed", BLUE,  "All deliverables done and approved");
  statusRow(doc, "Cancelled", GRAY,  "Project ended before completion");
  doc.y += 6;
  h2(doc, "Opening & Deleting Projects");
  body(doc, "Click any project card to open the full project detail view with the Kanban board, project info, budget, and related deliverables. To delete: hover the card and click the trash icon in the top-right corner. Deleting a project also removes all associated deliverables.");
  callout(doc, "note", "Client projects are the only type that appear in the Deliverables sharing dropdown. My Products are never shown there.");

  // ── §05 My Products ──
  sectionTitle(doc, "05", "My Products");
  body(doc, "Your personal workspace for internal projects — things you own and are building for yourself, not for a paying client. Apps, podcast, websites, brands, and any other self-owned product.");
  h2(doc, "Creating a Product");
  steps(doc, [
    "Click \"My Products\" in the sidebar",
    "Click \"New Product\"",
    "Enter the product name and select the platform that best describes it",
    "Optionally enter a budget or estimated development cost",
    "Click \"Create Product\"",
  ]);
  h2(doc, "Platform Types");
  bullets(doc, [
    "App Store — iOS or Android apps you publish and sell",
    "Podcast — audio shows and episodes you produce",
    "Website — web properties and domains you own",
    "Social Media — YouTube channels, Instagram accounts, and other social presence",
    "Other — anything that doesn't fit the categories above",
  ]);
  callout(doc, "tip", "My Products get the full Kanban board — perfect for managing app development milestones, podcast episode production pipelines, or website launch checklists.");

  // ── §06 Kanban ──
  sectionTitle(doc, "06", "Project Tasks & Kanban Board");
  body(doc, "Every project — whether a client project or an internal product — has a Kanban task board. Open it by clicking any project card from Client Projects or My Products.");
  h2(doc, "The Four Workflow Columns");
  bullets(doc, [
    "To Do — tasks not yet started",
    "In Progress — tasks actively being worked on right now",
    "Review — completed internally and awaiting quality check",
    "Done — fully finished, reviewed, and signed off",
  ]);
  h2(doc, "Adding a Task");
  steps(doc, [
    "Open a project by clicking its card",
    "Click \"New Task\" at the top right of the board",
    "Enter the task title and select a priority level: Low / Medium / High / Urgent",
    "Optionally set a due date and assign to a team member",
    "Click \"Add Task\" — it appears immediately in the To Do column",
  ]);
  h2(doc, "Moving Tasks & Priority Levels");
  body(doc, "Hover over any task card and click the \u2192 arrow button to advance it one column to the right. The flow is: To Do \u2192 In Progress \u2192 Review \u2192 Done.");
  bullets(doc, [
    "Low — gray badge, do when capacity allows",
    "Medium — blue badge, on the normal schedule",
    "High — orange badge, prioritize this week",
    "Urgent — red badge, needs immediate action today",
  ]);
  callout(doc, "tip", "Use the Review column as a mandatory quality gate before marking anything Done. It catches issues before they reach clients.");

  // ── §07 Expenses ──
  sectionTitle(doc, "07", "Expenses");
  body(doc, "Track every business cost in one organized place. Link expenses to specific projects for true profitability analysis, and use category filters to understand where money is going.");
  h2(doc, "Adding an Expense");
  steps(doc, [
    "Click \"Expenses\" in the sidebar (under Finance)",
    "Click \"Add Expense\"",
    "Enter a clear description, the amount, and select a category",
    "Enter the vendor name (optional but strongly recommended)",
    "Set the date — defaults to today but can be backdated",
    "Optionally link the expense to a specific project",
    "Click \"Add Expense\"",
  ]);
  h2(doc, "Categories & Filtering");
  bullets(doc, ["Equipment, Software, Talent, Location, Travel, Food, Supplies, Marketing, Other"]);
  body(doc, "Click any category pill in the filter bar to limit the list to that category. Click \"All\" to clear. Summary cards show Total (all-time), This Month, and total entry count.");
  callout(doc, "tip", "Always link expenses to their project. This data flows into the Reports P&L. Without it, your margin looks artificially high because costs are unattributed.");

  // ── §08 Invoices ──
  sectionTitle(doc, "08", "Invoices & Payments");
  body(doc, "Create, manage, and record payment on all client invoices. The summary strip at the top always shows your real financial position — collected, outstanding, and overdue.");
  h2(doc, "Creating an Invoice");
  body(doc, "The fastest path is via a Proposal or Contract: open an accepted proposal or signed contract and click the \"Create Invoice\" button — the client name and amount will be pre-filled.");
  steps(doc, [
    "Click \"Invoices\" in the sidebar or use \"Create Invoice\" from a proposal/contract",
    "Enter the client name, invoice amount, and due date",
    "Set status: \"Draft\" while preparing, \"Sent\" once delivered to the client",
    "Click \"Create Invoice\"",
  ]);
  h2(doc, "Recording a Payment");
  steps(doc, [
    "Hover the invoice row in the table — a Pay button appears on the right side",
    "Click Pay and select the payment method: Bank Transfer, Credit Card, Cash, Check, PayPal, Venmo, Zelle, or Other",
    "Confirm the payment date (defaults to today) and add an optional reference note",
    "Click \"Mark as Paid\" — the invoice updates to a green Paid badge immediately",
  ]);
  h2(doc, "Invoice Statuses");
  statusRow(doc, "Draft",     GRAY,     "Being prepared, not yet sent to the client");
  statusRow(doc, "Sent",      BLUE,     "Delivered to the client, awaiting payment");
  statusRow(doc, "Paid",      GREEN,    "Payment received and recorded");
  statusRow(doc, "Overdue",   "#DC2626","Past the due date with no payment recorded");
  statusRow(doc, "Cancelled", GRAY,     "Invoice voided — excluded from all totals");
  doc.y += 6;
  h2(doc, "Summary Strip");
  bullets(doc, [
    "Collected — sum of all Paid invoices. This is real cash received.",
    "Pending — sum of all Sent invoices. Money clients still owe you.",
    "Overdue — sum of all invoices past their due date with no payment.",
  ]);
  callout(doc, "tip", "Review the Pending and Overdue numbers every Monday. A growing Overdue balance means your collection process needs attention — follow up immediately rather than letting it age.");

  // ── §09 Estimator ──
  sectionTitle(doc, "09", "Estimator");
  body(doc, "Build detailed, itemized project quotes before any work begins. A formal estimate sets clear expectations on scope and price, protects you from scope creep, and is the starting point for the full revenue pipeline.");
  h2(doc, "Creating an Estimate");
  steps(doc, [
    "Click \"Estimator\" in the sidebar and click \"New Estimate\"",
    "Enter the client name and a descriptive project title",
    "Add line items — each has a description, quantity, and unit rate",
    "Set a tax rate percentage if applicable",
    "Save as Draft while preparing; change to Sent once shared with the client",
  ]);
  h2(doc, "Estimate Statuses");
  statusRow(doc, "Draft",    GRAY,  "Still being built — not yet shared");
  statusRow(doc, "Sent",     BLUE,  "Shared with the client for review");
  statusRow(doc, "Accepted", GREEN, "Client approved — ready to convert to a Proposal");
  statusRow(doc, "Declined", GRAY,  "Client passed on the quote");
  doc.y += 6;
  h2(doc, "Converting to a Proposal");
  body(doc, "Once a client verbally or informally accepts an estimate, open the estimate and click \"Create Proposal\" to generate a formal Proposal based on the same line items. The Proposal is what the client formally accepts in writing through the portal or in person.");
  callout(doc, "tip", "Always convert accepted estimates to Proposals before starting work. Estimates are internal pricing tools. Proposals and Contracts are the client-facing legal record of what was agreed.");

  // ── §10 Proposals ──
  sectionTitle(doc, "10", "Proposals");
  body(doc, "A Proposal is the formal, client-facing version of a quote — it lists exactly what will be delivered, at what price, and gives the client a clear way to accept or decline. Proposals are visible to clients in their portal under the Proposals tab.");
  h2(doc, "Creating a Proposal");
  body(doc, "You can create a proposal directly or by converting an accepted estimate (recommended). To create directly:");
  steps(doc, [
    "Click \"Proposals\" in the sidebar and click \"New Proposal\"",
    "Enter the client name and a clear, professional project title",
    "Add a description and any notes you want the client to see",
    "Add line items — description, quantity, and unit rate for each deliverable",
    "Set a tax rate and a validity date (date after which the quote expires)",
    "Save as Draft while preparing; change to Sent once ready for the client",
  ]);
  h2(doc, "Proposal Statuses");
  statusRow(doc, "Draft",    GRAY,   "Being prepared — not yet visible to the client");
  statusRow(doc, "Sent",     SKY,    "Visible in the client portal — awaiting their response");
  statusRow(doc, "Accepted", GREEN,  "Client accepted — move forward with a Contract");
  statusRow(doc, "Rejected", "#DC2626","Client declined — follow up to understand objections");
  doc.y += 6;
  h2(doc, "Client Acceptance Flow");
  body(doc, "When you set a proposal to Sent, it becomes visible immediately in the client's portal under their Proposals tab. The client can review the full line-item breakdown and click Accept or Decline directly from the portal. You see the response reflected instantly in the Proposals list.");
  h2(doc, "From Accepted Proposal to Contract");
  body(doc, "Open an accepted proposal and click \"Create Contract\" to generate a pre-filled contract using the same client name, proposal ID, and notes. This keeps the entire pipeline linked for auditing and reporting purposes.");
  callout(doc, "tip", "The Accounting flash report tracks Proposals Sent, Proposals Accepted, and rejection rate. Use these numbers monthly to identify if your win rate is trending up or down and adjust your pricing or positioning accordingly.");

  // ── §11 Contracts ──
  sectionTitle(doc, "11", "Contracts");
  body(doc, "A Contract is the legally binding agreement between Accelerated Experiences and a client. It documents the full scope, payment terms, deliverables, and any other conditions. AE Hub lets you draft, send, and collect digital signatures — all tracked in one place.");
  h2(doc, "Creating a Contract");
  body(doc, "The recommended path is to create a contract from an accepted proposal. To create directly:");
  steps(doc, [
    "Click \"Contracts\" in the sidebar and click \"New Contract\"",
    "Enter the client name and client email address",
    "Enter a clear contract title (e.g. \"Smith Wedding Film — Production Agreement\")",
    "Write or paste the full contract body in the content field",
    "Add any internal notes (not visible to the client)",
    "Save as Draft while finalizing; click \"Send\" when ready to share",
  ]);
  h2(doc, "Contract Statuses");
  statusRow(doc, "Draft",    GRAY,   "Being prepared — not yet visible to the client");
  statusRow(doc, "Sent",     SKY,    "Visible in the client portal — awaiting signature");
  statusRow(doc, "Signed",   GREEN,  "Client signed — work can proceed");
  statusRow(doc, "Executed", PURPLE, "Fully executed — all obligations complete");
  doc.y += 6;
  h2(doc, "Client Signing Flow");
  body(doc, "When you set a contract to Sent, it appears in the client's portal under the Contracts tab. The client can read the full contract text and see sent and signed dates. Signature collection is handled outside the portal (e.g. email, in person, or a linked signing tool) — the contract record serves as your internal tracking record.");
  h2(doc, "Linking to the Invoice");
  body(doc, "Once a contract is signed, open it and click \"Create Invoice\" to generate an invoice with the client name pre-filled. This closes the pipeline loop: Estimate \u2192 Proposal \u2192 Contract \u2192 Invoice \u2192 Paid.");
  callout(doc, "admin", "Always have a signed contract before beginning substantial work. The Contract page's Signed count in the Accounting flash report is your measure of work that is legally authorized to proceed.");

  // ── §12 Deliverables ──
  sectionTitle(doc, "12", "Deliverables");
  body(doc, "The file handoff and approval workflow. Share completed work with clients and collect their formal sign-off — all without email back-and-forth. When you share a deliverable, it appears automatically in the client's portal Deliverables tab.");
  h2(doc, "Sharing a Deliverable");
  steps(doc, [
    "Click \"Deliverables\" in the sidebar and click \"Share Deliverable\"",
    "Select the client project from the dropdown — only client projects appear here",
    "Enter a title that is clear and professional to the client",
    "Add a description giving the client context about what they are reviewing",
    "Paste the file URL — Google Drive, Dropbox, Frame.io, WeTransfer, or any accessible link",
    "Enter the client's email — must exactly match their client portal registration email",
    "Click \"Share Deliverable\"",
  ]);
  h2(doc, "Deliverable Statuses");
  statusRow(doc, "Pending Review",     AMBER,    "Shared — client has not yet acted on it");
  statusRow(doc, "Approved",           GREEN,    "Client clicked Approve. Delivery is complete.");
  statusRow(doc, "Revision Requested", "#DC2626","Client asked for changes. Their note is on the card.");
  doc.y += 6;
  h2(doc, "Filtering & Handling Revisions");
  body(doc, "Use the tabs at the top of the page — All, Pending Review, Revisions Requested, Approved — to focus on what needs attention. When a client requests revisions, their written note appears directly on the card. Address the feedback, update the file, then share a new deliverable.");
  callout(doc, "tip", "After a client approves, that record is permanently stored. The Approved tab is your complete archive of all signed-off work — valuable for any future scope dispute.");

  // ── §13 Client Portal ──
  sectionTitle(doc, "13", "Client Portal");
  body(doc, "A secure, separate area at /client on the same app URL. Clients log in with their own credentials and access a four-tab portal showing all content you have specifically shared with their account.");
  h2(doc, "The Four Portal Tabs");
  bullets(doc, [
    "Deliverables — all files shared with the client's email. Clients can Approve or Request Changes.",
    "Proposals — all non-draft proposals linked to the client's account. Clients can Accept or Decline.",
    "Invoices — all non-draft, non-cancelled invoices where the client name matches the portal account.",
    "Contracts — all non-draft contracts where the client email matches the portal account.",
  ]);
  h2(doc, "Setting Up a Client Account");
  steps(doc, [
    "Tell the client to visit the app URL and click \"Client portal\" at the bottom of the sign-in screen",
    "Client clicks \"Register\" and creates an account with their name, email, and a password",
    "Admin approves the client account from the Approvals page in the main app",
    "Client can sign in immediately and will see all previously shared content for their email",
  ]);
  h2(doc, "What Clients Can Do");
  bullets(doc, [
    "Deliverables — open file links, click Approve, or click Request Changes with a written note",
    "Proposals — view full line-item breakdowns, click Accept or Decline",
    "Invoices — view their invoice history with amounts, due dates, and payment dates",
    "Contracts — view the full contract text and signing status",
  ]);
  h2(doc, "What Clients Cannot See");
  bullets(doc, [
    "Other clients' files, proposals, invoices, or contracts",
    "Expenses, team members, time logs, or any internal operational data",
    "The main employee application or any administrative functions",
    "Internal products (My Products) or anything not matched to their email",
  ]);
  callout(doc, "note", "Deliverables are matched by email. Invoices are matched by client name (case-insensitive). Contracts and Proposals are matched by client email. Make sure names and emails are consistent when creating records.");

  // ── §14 Deadlines ──
  sectionTitle(doc, "14", "Deadlines");
  body(doc, "A flat, prioritized list of all important due dates across every project. Open it every morning to see what is due today, tomorrow, and this week.");
  h2(doc, "Adding a Deadline");
  steps(doc, [
    "Click \"Deadlines\" in the sidebar and click \"Add Deadline\"",
    "Enter the deadline title, select a priority level, and set the due date",
    "Optionally link to a project and assign to a team member",
    "Click \"Save\"",
  ]);
  h2(doc, "Priority Levels");
  statusRow(doc, "Urgent", "#DC2626","Must be handled today — escalate if not on track");
  statusRow(doc, "High",   AMBER,   "Must be addressed this week — do not let it slip");
  statusRow(doc, "Medium", BLUE,    "On the normal schedule — important but not critical");
  statusRow(doc, "Low",    GRAY,    "Handle when capacity allows");
  doc.y += 6;
  body(doc, "Click the circle checkbox on any deadline to mark it complete. Completed items move to the bottom, keeping active items at the top.");
  callout(doc, "tip", "Use Deadlines for external commitments to clients. Use the Kanban board for the internal workflow steps that lead up to those dates.");

  // ── §15 Time Tracking ──
  sectionTitle(doc, "15", "Time Tracking");
  body(doc, "Log hours worked on any project by any team member. Time entries connect to individual hourly rates to calculate billable revenue and the true labor cost of each project.");
  h2(doc, "Logging Time");
  steps(doc, [
    "Click \"Time Tracking\" in the sidebar and click \"Log Time\"",
    "Select the project and the team member who performed the work",
    "Enter the number of hours and a description of the specific work done",
    "Check \"Billable\" if this time is being charged to the client",
    "Click \"Save\"",
  ]);
  h2(doc, "Billable vs Non-Billable");
  body(doc, "Billable hours × hourly rate = estimated revenue in the Reports section. Non-billable time — internal meetings, admin work, complimentary revisions, scope overruns — is tracked but excluded from revenue figures. A high non-billable percentage on a project signals scope creep or pricing issues.");
  callout(doc, "tip", "Log time at the end of each working day without exception. It takes under two minutes and produces the accurate data needed for monthly P&L reviews, performance evaluations, and future project pricing.");

  // ── §16 Clients CRM ──
  sectionTitle(doc, "16", "Clients (CRM)");
  body(doc, "Your private internal contact management system for all existing clients and prospective leads. Completely separate from the Client Portal — clients never see or access this section.");
  h2(doc, "Adding a Client or Lead");
  steps(doc, [
    "Click \"Clients\" in the sidebar (under People)",
    "Click \"Add Client\"",
    "Enter their full name, company, email, and phone number",
    "Set their status: \"Lead\" for a prospect, \"Active\" for a current client",
    "Click \"Save\"",
  ]);
  h2(doc, "Client Statuses");
  statusRow(doc, "Lead",     BRAND, "A prospect you are in discussions with — not yet under contract");
  statusRow(doc, "Active",   GREEN, "A current paying client with ongoing or recent work");
  statusRow(doc, "Inactive", GRAY,  "A past client with no current active projects");
  doc.y += 6;
  body(doc, "When a prospect signs a contract and becomes a paying client, open their record and click \"Convert to Active\". Their status updates and their full contact history is preserved.");
  callout(doc, "tip", "Add detailed notes to every lead record — services they're interested in, their approximate budget, and the date of your most recent conversation. That context makes follow-up calls far more productive.");

  // ── §17 Team ──
  sectionTitle(doc, "17", "Team");
  body(doc, "Manage your team members, their roles, and hourly billing rates. Team data connects directly to Time Tracking for revenue calculations and to Reports for performance and utilization analytics.");
  h2(doc, "Adding a Team Member");
  steps(doc, [
    "Click \"Team\" in the sidebar (under People)",
    "Click \"Add Member\"",
    "Enter their full name, role, and work email address",
    "Enter their hourly billing rate in dollars",
    "Set their status to Active and click \"Save\"",
  ]);
  h2(doc, "Roles & Performance Cards");
  bullets(doc, ["Available roles: Photographer, Videographer, Designer, Editor, Producer, Manager, Other"]);
  body(doc, "Each team member card automatically displays two calculated metrics: total hours logged across all projects, and estimated revenue generated — billable hours × hourly rate. Both update in real-time as time entries are added.");
  callout(doc, "admin", "Hourly rate data is sensitive compensation information. Be intentional about who in your organization has employee-level access to AE Hub.");

  // ── §18 Accounting ──
  sectionTitle(doc, "18", "Accounting");
  body(doc, "The Accounting page is your financial command center — a live flash report showing the full revenue pipeline, PM forecasts, monthly revenue flow, and individual estimate performance. Use it on the last business day of every month without exception.");
  h2(doc, "The Revenue Workflow Map");
  body(doc, "At the top of the Accounting page, a visual workflow shows every stage of the AE revenue pipeline in order:");
  bullets(doc, [
    "Vendor Catalog \u2192 Estimate: Draft \u2192 Estimate: Sent",
    "\u2192 Proposal Sent \u2192 Proposal Accepted \u2192 Contract Signed",
    "\u2192 Project + Expenses \u2192 Invoice Sent \u2192 Collected \u2192 Flash Report",
  ]);
  h2(doc, "Flash Report Summary Bar");
  body(doc, "Six cards show the current month's pipeline health:");
  bullets(doc, [
    "Forecasted — total value of all active PM forecasts",
    "Proposals Sent — dollar value of proposals currently awaiting client response",
    "Proposals Accepted — dollar value of accepted proposals",
    "Contracts Active — dollar value tied to signed or executed contracts",
    "Invoiced — total invoiced this month (non-cancelled)",
    "Collected — cash received this month. The only number that is real money.",
  ]);
  h2(doc, "Revenue Flow Chart");
  body(doc, "A waterfall-style chart shows how value moves from Forecasted \u2192 Proposals Sent \u2192 Proposals Accepted \u2192 Contracts Active \u2192 Invoiced \u2192 Collected. The drop-off between stages reveals your conversion bottlenecks — a large gap between Proposals Sent and Accepted means a pricing or positioning problem; a large gap between Invoiced and Collected means a collections problem.");
  h2(doc, "PM Forecasts");
  body(doc, "Project Managers can add revenue forecasts with a probability percentage. The weighted forecast (value × probability) appears in the Forecasted cards and the Revenue Flow chart. Use these to predict cash flow 30-90 days ahead.");
  h2(doc, "Month Navigation");
  body(doc, "Use the arrow buttons at the top right of the Accounting page to review any prior month's data. All charts and cards update to reflect the selected month.");
  callout(doc, "tip", "The gap between Collected and Forecasted is your primary early-warning signal. If Collected is consistently less than 60% of Forecasted, you have a structural pricing, conversion, or collections problem that needs immediate attention.");

  // ── §19 Reports ──
  sectionTitle(doc, "19", "Reports");
  body(doc, "Financial and operational analytics synthesized from live data — Profit & Loss, revenue by client, and team performance — all in one view. Use it at the end of every month without exception.");
  h2(doc, "Profit & Loss");
  body(doc, "Shows total revenue (sum of all Paid invoices) minus total expenses for the selected period. The net figure is your profitability. A consistently negative net means expenses are outpacing revenue. Use the expense category filters to investigate which cost areas are the culprit.");
  h2(doc, "Revenue by Client");
  body(doc, "A chart showing the revenue contribution of each client over the selected period. Use this to identify your most valuable client relationships. Heavy concentration in a single client represents a business risk worth proactively addressing through diversification.");
  h2(doc, "Team Performance");
  body(doc, "A breakdown of hours logged, billable vs. non-billable split, and estimated revenue generated per team member. Use this in performance reviews, when evaluating compensation changes, and for decisions about team capacity and hiring.");
  callout(doc, "tip", "Run the Profit & Loss report on the last business day of every month. Reviewing revenue versus expenses monthly is the single most important financial discipline for a small service business.");

  // ── §20 Branding ──
  sectionTitle(doc, "20", "Branding");
  body(doc, "Customize the visual appearance of AE Hub to match the Accelerated Experiences brand. Changes apply immediately across the entire application.");
  h2(doc, "What You Can Customize");
  bullets(doc, [
    "Logo — upload your own image file. PNG with transparent background or SVG recommended.",
    "Primary color — main accent used for active sidebar links, buttons, and key UI highlights",
    "Accent color — secondary color used to support the primary across the interface",
    "Theme — toggle between Light mode and Dark mode",
  ]);
  steps(doc, [
    "Click \"Branding\" in the sidebar (under Settings)",
    "Upload a new logo or adjust brand colors using the color pickers",
    "Preview changes before saving",
    "Click \"Save\" — changes take effect immediately for all users",
  ]);
  callout(doc, "tip", "Having your own logo and brand colors makes a noticeably more professional impression when you share your screen during client presentations or video calls.");

  // ── §21 Admin: Approvals ──
  sectionTitle(doc, "21", "Admin: Approvals");
  body(doc, "Visible only to Admin accounts. The security gate for the entire system — no new user of any type can access AE Hub until an Admin explicitly reviews and approves their registration. This applies to both employee and client accounts.");
  h2(doc, "The Approval Badge");
  body(doc, "When a new registration is pending, a red badge appears on \"Approvals\" in the Admin sidebar showing the count of pending requests. It refreshes automatically every 30 seconds.");
  h2(doc, "Approving Employee & Client Accounts");
  steps(doc, [
    "A new user registers (employees at /sign-up, clients at /client/register)",
    "A red badge appears on the Approvals sidebar item",
    "Click \"Approvals\" and carefully review the registration details",
    "Click \"Approve\" to grant access or \"Reject\" to deny the request",
    "Approved users can sign in immediately with the credentials they registered",
  ]);
  body(doc, "Clients who register appear under a separate Clients tab on the Approvals page. Once approved, clients see any content already shared with their email.");
  h2(doc, "Security Best Practices");
  bullets(doc, [
    "Never approve an account you do not personally recognize",
    "If a name or email seems unfamiliar, reject it and have the person contact you directly",
    "When a team member leaves, change or disable their account promptly",
    "Never share the Admin PIN with non-admin personnel under any circumstances",
  ]);
  callout(doc, "admin", "Any approved employee account gains full access to all client data, project financials, and team information. Treat every approval as a real security decision.");

  // ── §22 Agent Hub ──
  sectionTitle(doc, "22", "Agent Hub");
  body(doc, "AE Hub includes a built-in AI team — four specialized agents that cover creative direction, project management, financial analysis, and administrative operations. Each agent has full awareness of your live data and works as a genuine member of the AE team.");
  h2(doc, "Sharon — AI Creative Director");
  body(doc, "Route: /sharon   \u00B7   Access: all employees");
  bullets(doc, [
    "End-to-end creative production: YouTube packages, brand guides, campaign concepts, website specs, 3D game briefs",
    "Disciplines: video, photography, branding, social media, podcast, web, mobile, code, 3D, gaming, ads, music",
    "Assigns and directs Rex (scripts), Bentley (visuals), Summer (video edit), Olive (photo), Spark (web), Bolt (mobile), Pixel (3D)",
    "When a project involves social media, Sharon briefs VIBE at /social-dept on the creative direction",
    "Request Revision button: Sharon regenerates based on your feedback",
  ]);
  h2(doc, "Dolly — AI Project Manager");
  body(doc, "Route: /dolly   \u00B7   Access: all employees");
  bullets(doc, [
    "Breaks any project into prioritized tasks with roles, timelines, and milestones",
    "Produces vendor recommendations with cost estimates",
    "Full budget breakdown — tracks spending vs. remaining budget in real time",
    "Purchase Requests: generated by Dolly, approved by Admin before any spend",
    "Reports directly to Anetta — Anetta assigns and briefs Dolly on all new projects",
  ]);
  h2(doc, "Geoffrey — AI CFO / Accountant");
  body(doc, "Route: /geoffrey   \u00B7   Access: admin, accounting");
  bullets(doc, [
    "Financial Analysis: pulls all invoices, expenses, projects — calculates GP margin, tax liability, quarterly payments, and the week's top financial priority",
    "Opportunity Radar: scores revenue health 0-100, finds cost leaks by category, surfaces 3-4 high-margin opportunities AE isn't pursuing",
    "Grant Hunt: 9 curated grants matched to AE's profile (Amber, MBDA, NEA, Google Black Founders, SBIR, and more) with urgency levels",
    "Action Requests: Geoffrey proposes actions (invoice follow-ups, tax payments, fixes) — Admin approves before Geoffrey executes",
    "Wealth Playbook: long-term wealth building strategy for the founders",
    "Product Pricing: send any internal product to Geoffrey and he returns a launch-price recommendation with model, range, comparables, and break-even math",
  ]);
  h2(doc, "Anetta — AI Administrative Assistant");
  body(doc, "Route: /anetta   \u00B7   Inbox: /anetta/inbox   \u00B7   Filing Approvals: /anetta/filing   \u00B7   Access: all employees (inbox + filing: admin only)");
  bullets(doc, [
    "Draft emails for any purpose — client follow-ups, vendor outreach, department coordination, grant communications",
    "All drafts go to /anetta/inbox for Admin approval before sending — nothing sends automatically",
    "Manages the AE filing system: every document any agent produces gets routed through Anetta for naming and folder placement",
    "Grant writing pipeline: ask Anetta to start grant planning and she runs the full Phase 1 \u2192 Admin Gate \u2192 Phase 2 \u2192 Final Review workflow",
    "Cross-department coordination: ask Anetta to get a status update from all departments at once",
    "Email formatting: internal notes use plain text; anything going to a client or partner is formatted HTML with the company signature",
  ]);
  callout(doc, "tip", "Use Anetta as your first stop for anything administrative. If you are not sure who to ask, ask Anetta — she knows the entire AE team and will route your request to the right person.");

  // ── §23 Bobert & Creative Studio ──
  sectionTitle(doc, "23", "Bobert & Creative Studio");
  body(doc, "The Creative Studio (/creative) is a unified AI workspace powered by Bobert, AE's on-demand builder and general assistant. Bobert is available on every page as a persistent chat panel — he also lives full-time inside /creative where he can actually build things.");
  h2(doc, "What Bobert Can Build");
  bullets(doc, [
    "Images, logos, artwork, web mockups, mobile mockups — using Gemini image generation",
    "Websites and landing pages, mobile app screens, browser games, React components, API routes, scripts — using code generation",
    "On any page: answers questions, drafts copy, does research, explains data, writes code, points you to the right specialist",
  ]);
  h2(doc, "The /creative Workspace");
  body(doc, "The main Creative Studio workspace at /creative has a full-page chat with Bobert and a project system for saving your work. Use the toolbar above the chat to: New Project (clear workspace), Open (load a saved project), Save (snapshot + all assets). Hover any asset card to delete it. Voice input is available via the mic button.");
  h2(doc, "Sub-Tools in Creative Studio");
  bullets(doc, [
    "Creative Briefs (/creative/briefs) — click the \u26A1 \u22183 Directions\u2019 button to generate Bold, Emotional, and Minimal creative directions in parallel. Click any direction to auto-fill your brief.",
    "Shot Lists (/creative/shot-lists) — scenes, equipment, crew, and location planning for any shoot",
    "Project Mockups (/creative/mockups) — designer-built mockups with threaded comment reviews",
    "Podcast Studio (/creative/podcast) — shows, episodes, and guest management",
    "3D Game Studio (/creative/game-studio) — browser-based 3D game builder powered by Pixel",
    "Photo Editor, Social Designer, Video Editor, Beat Maker — production-role tools",
  ]);
  h2(doc, "Architecture Page");
  body(doc, "Route: /creative/architecture   \u00B7   Access: Admin only");
  body(doc, "Generates world-class build prompts for apps, websites, and business systems. After generating and reviewing the plan, click \u201CApprove & Send to Bobert\u201D to hand the prompt to Bobert automatically. Bobert receives it in /creative and starts building immediately.");
  callout(doc, "admin", "Architecture is admin-only by design. The prompts it generates can initiate substantial build work — treat every approval as a real technical decision about what gets built.");

  // ── §24 Automation Department ──
  sectionTitle(doc, "24", "Automation Department");
  body(doc, "Route: /automation   \u00B7   Access: Admin only\n\nThe Automation Department is a three-agent team that finds, designs, and calculates the ROI of every automation opportunity across AE's workflows. They report to Bobert, who represents Anthony's business growth vision. Every recommendation goes to Anthony for approval before any implementation.");
  h2(doc, "The Three Automation Agents");
  bullets(doc, [
    "ARIA (Chief Automation Officer) \u2014 team lead, synthesizes insights from APEX and ORACLE into unified strategic recommendations. Anthony's primary contact for all automation strategy. Every analysis ends with a bold 'Recommended Next Step.' Use ARIA's Team Analysis mode for a full scan.",
    "APEX (Automation Process Expert) \u2014 maps every workflow AE uses, finds the manual and repetitive tasks, proposes specific technical automations. For each opportunity: current state, proposed automation tool (Zapier/Make/n8n/AI/custom), hours saved, complexity, dependencies, and cost estimate.",
    "ORACLE (Revenue Analytics) \u2014 calculates ROI for every opportunity. Produces dollar savings, payback period, revenue uplift potential, and implementation risk scoring. Prioritizes opportunities by financial return.",
  ]);
  h2(doc, "Domains Covered");
  bullets(doc, [
    "CRM & Sales: lead capture, outreach sequences, follow-up automation, pipeline management",
    "Invoicing & Collections: payment reminder sequences, overdue escalation, reconciliation",
    "Client Management: onboarding checklists, deliverable approval workflows, communication templates",
    "Project Management: task creation automation, deadline alerts, status reporting",
    "Marketing & Content: social scheduling, outreach automation, campaign triggers, analytics reporting",
    "Admin: document generation, data entry elimination, scheduling automation, internal reporting",
    "Financial: expense categorization, payroll prep, vendor payment scheduling, forecasting",
  ]);
  h2(doc, "Running an Automation Scan");
  steps(doc, [
    "Go to /automation and open ARIA",
    "Ask ARIA to run a full opportunity scan (or focus on a specific department or workflow)",
    "ARIA collects APEX's process analysis and ORACLE's ROI models, then synthesizes into one ranked priority list",
    "Review ARIA's recommendation list — each item shows hours saved, dollar impact, payback period, and complexity",
    "Approve the opportunities you want to implement — ARIA and the IT Department coordinate on execution",
  ]);
  callout(doc, "note", "The Automation Department works closely with IT — FORGE flags every recurring manual fix as an automation opportunity for ARIA. If the same problem keeps happening, it gets automated away.");

  // ── §25 IT Department ──
  sectionTitle(doc, "25", "IT Department");
  body(doc, "Route: /it-department   \u00B7   Access: Admin only\n\nThe IT Department is AE's production reliability team. Three specialized agents handle system health, diagnostics, and remediation. NEXUS leads the team and reports directly to Anthony. Every response from NEXUS ends with a bold 'NEXUS Recommendation' — Anthony's clear action item.");
  h2(doc, "The Three IT Agents");
  bullets(doc, [
    "NEXUS (IT Manager) \u2014 incident command. Coordinates CIPHER and FORGE, synthesizes their work into one concise incident report. Manages the Incidents board. Use NEXUS first for any unknown system issue. Use the Team Analysis button for major incidents requiring the full team.",
    "CIPHER (Diagnostics Specialist) \u2014 root-cause analysis. Production log analysis, database health checks, auth and session failures, API route diagnosis, cron job health, environment variable auditing, security posture review, third-party integration failures. Produces: Error Signature, Affected Surface, Root Cause, Evidence, and Confidence level.",
    "FORGE (Reliability Engineer) \u2014 remediation and repair. Step-by-step fix sequences with exact commands, deployment health, database recovery, environment configuration, cron job recovery, performance remediation. Produces: Fix Steps, Estimated Time, Risk Level, Rollback Plan, Prevention Runbook.",
  ]);
  h2(doc, "Incident Severity Scale");
  statusRow(doc, "CRITICAL \ud83d\udd34", "#DC2626", "System down / data loss / payment failure / auth broken — report to IT immediately");
  statusRow(doc, "HIGH \ud83d\udfe0",     AMBER,     "Major feature broken / email delivery failing / significant performance degradation — same-day priority");
  statusRow(doc, "MEDIUM \ud83d\udfe1",   "#CA8A04",  "Minor feature broken / non-critical errors / slow degradation — queue in IT Incidents");
  statusRow(doc, "LOW \ud83d\udfe2",      GREEN,     "Cosmetic issues / minor UX bugs / non-urgent improvements — scheduled maintenance");
  doc.y += 6;
  h2(doc, "Reporting a System Issue");
  steps(doc, [
    "Go to /it-department and open NEXUS",
    "Describe exactly what is broken: which page, feature, or endpoint; the exact error message; when it started; who is affected",
    "Note whether the issue is in production (accelerated-experiences-1.replit.app) or the dev preview pane",
    "NEXUS classifies severity, routes to CIPHER for diagnosis and FORGE for the fix, then returns a unified incident report",
    "Follow the 'NEXUS Recommendation' at the bottom of the report — it tells you exactly what to do next",
  ]);
  callout(doc, "tip", "The more context you give NEXUS upfront, the faster CIPHER can pinpoint the root cause. Exact error text, the URL of the broken page, and when it started are the three most useful details.");

  // ── §26 Social Media Department ──
  sectionTitle(doc, "26", "Social Media Department");
  body(doc, "Route: /social-dept   \u00B7   Access: Admin only\n\nThree AI specialists handle every dimension of social media work — strategy, copy, and analytics. They are production specialists, not generalists. VIBE leads the team and reports to Sharon. Route all social media campaign work here after creating the project.");
  h2(doc, "The Three Social Media Agents");
  bullets(doc, [
    "VIBE (Director of Social Media) \u2014 team lead, reports to Sharon. Viral campaign architecture, YouTube strategy, full-funnel social media integration, social automation for clients, and cross-department coordination. VIBE leads with a Team Campaign Analysis that Sharon briefs him on first.",
    "ECHO (Content & Copy Specialist) \u2014 platform-native copywriting for X (Twitter), Instagram, Facebook, LinkedIn, TikTok, and YouTube. Viral hook writing, brand voice architecture, campaign copy systems, content calendars, and trend integration. ECHO writes everything that gets published.",
    "PRISM (Analytics Specialist) \u2014 campaign performance analysis, audience intelligence, ROI attribution, KPI dashboard setup, forecasting, and optimization recommendations. PRISM makes every social media decision data-backed and reports results back to Sharon and Anthony.",
  ]);
  h2(doc, "Campaign Workflow");
  steps(doc, [
    "Create the client or internal product project in AE Hub",
    "Brief Dolly on the project timeline so PM tasks are scaffolded",
    "Go to /social-dept with Sharon's creative brief and open VIBE",
    "Run VIBE's Team Campaign Analysis — VIBE collects ECHO's copy strategy and PRISM's KPI framework, then synthesizes into one full campaign brief",
    "Review the campaign brief: platform mix, content calendar, copy packages, and KPI targets",
    "ECHO produces the copy for each platform; PRISM sets up the performance dashboard",
    "Sharon reviews all copy before it goes live; Anetta files the campaign strategy",
    "Post-launch: PRISM reports back at 2 weeks with performance data and optimization recommendations",
  ]);
  callout(doc, "tip", "Always send the social campaign brief through VIBE before any copy is written. ECHO writes better content when VIBE has already defined the platform strategy and audience targeting.");

  // ── §27 Digital Inventors ──
  sectionTitle(doc, "27", "Digital Inventors");
  body(doc, "Route: /inventors   \u00B7   Access: Admin only\n\nThe Digital Inventors department is AE's strategic innovation engine. Four specialized AI agents identify new product and market opportunities, validate them with data, engineer the concept, and define the marketing approach. EINSTEIN leads the team and reports directly to Anthony.");
  h2(doc, "The Four Invention Agents");
  bullets(doc, [
    "EINSTEIN (Director of Digital Innovation) \u2014 team lead, reports to Anthony. Synthesizes the team's work into a single Invention Brief. Focuses on the intersection of AE's creative expertise, existing verticals, and emerging technology. Every brief ends with a bold 'EINSTEIN Recommendation' telling Anthony exactly what to do next.",
    "NOVA (Market Intelligence) \u2014 finds market gaps, new niches, and untapped opportunities. Provides the WHERE — which markets AE should enter, which verticals are underserved, which timing windows are open. Specialty: psychographic and demographic targeting across AE's current client base.",
    "LYRA (Marketing Data & Brand Strategy) \u2014 provides marketing data and targeting intelligence. Determines WHO will buy the product and WHY they'll pay for it. Validates market sizing and segments, competitive landscape, and brand fit within the AE portfolio.",
    "VEGA (Chief Product Engineer) \u2014 designs and engineers the concept. Provides the HOW — product spec, platform, core features, technical feasibility. Certifies that the invention is buildable with AE's current team and stack.",
  ]);
  h2(doc, "The Invention Brief Format");
  body(doc, "Every EINSTEIN Team Analysis produces a structured Invention Brief:");
  bullets(doc, [
    "\ud83d\udd2d THE OPPORTUNITY \u2014 one crisp paragraph framing the market insight",
    "\ud83d\udcca MARKET PROOF (from LYRA) \u2014 data, segments, and market size",
    "\ud83d\uddfa WHO BUYS IT (from NOVA) \u2014 psychographic and demographic profile",
    "\u2699\ufe0f WHAT IT IS (from VEGA) \u2014 product spec, platform, core features",
    "\ud83c\udfc6 WHY AE WINS \u2014 unfair advantages and competitive position",
    "\ud83d\ude80 FIRST MOVE \u2014 concrete 30-day action to capture the opportunity",
  ]);
  h2(doc, "When to Engage the Inventors");
  steps(doc, [
    "Go to /inventors and open EINSTEIN",
    "Describe the opportunity you are sensing \u2014 a market gap, an underserved vertical, a product idea, or a question about what to build next",
    "Ask EINSTEIN to run a Team Analysis \u2014 NOVA researches the market, LYRA validates targeting, VEGA engineers the concept",
    "Review the full Invention Brief and EINSTEIN's recommendation",
    "If the brief includes a social media launch component, EINSTEIN will brief VIBE at /social-dept automatically",
    "Approve and hand off to the relevant AE departments to execute",
  ]);
  callout(doc, "tip", "The Inventors work best when given a direction to investigate, not a fully-formed answer to validate. 'What should we build for the senior living vertical?' produces far more valuable output than 'Is our app X a good idea?'");

  // ── §28 Filing Cabinet & Notes ──
  sectionTitle(doc, "28", "Filing Cabinet & Notes");
  h2(doc, "Filing Cabinet");
  body(doc, "Route: /files   \u00B7   Access: all employees (except product testers)\n\nThe central document storage for everything AE produces. Every document any agent generates — briefs, contracts, invoices, campaign strategies, invention briefs, grant submissions, analytics reports — is stored here after Anetta files it.");
  bullets(doc, [
    "Browse files organized by folder: /AE/Clients, /AE/Internal_Products, /AE/Operations, /AE/Grants, /AE/Marketing, /AE/Archive",
    "Search by filename, folder, or date",
    "Download any file directly from the browser",
    "Files are named using AE's standard convention: YYYY-MM-DD_TYPE_CONTEXT_DESCRIPTION_vN.ext",
  ]);
  h2(doc, "How Files Get Into the Cabinet");
  body(doc, "Anetta owns all filing. When any agent (Sharon, Geoffrey, VIBE, EINSTEIN, or any other) produces a document, it is routed to Anetta for naming and folder placement. Anetta queues a filing request that appears at /anetta/filing for Admin review.");
  steps(doc, [
    "An agent generates a document (brief, invoice, campaign strategy, etc.)",
    "Anetta receives the filing request and proposes a folder and filename following the AE naming convention",
    "Admin reviews the request at /anetta/filing — confirm Anetta's suggestion, override the folder or filename, or reject",
    "Approved files appear in /files immediately, organized in the correct folder",
  ]);
  callout(doc, "admin", "Some events fire Anetta's filing automatically — creating an internal product, generating an invoice, creating a proposal or contract. Agents can also request filing manually for any ad-hoc deliverable they produce.");
  h2(doc, "Notes — Built-in Word Processor");
  body(doc, "Route: /notes   \u00B7   Sidebar: Workspace \u2192 Notes   \u00B7   Access: all employees");
  bullets(doc, [
    "Rich-text editor with: bold, italic, headings, bullet lists, numbered lists, blockquotes, undo/redo",
    "Autosave — nothing is lost",
    "Pin notes to keep them at the top of your list",
    "Full-text search across all notes",
    "Notes are private per employee — no one else sees your notes",
    "Best uses: drafting customer-facing copy, meeting agendas, brainstorms, anything you'd type in Google Docs",
  ]);

  // ── §29 Calendar ──
  sectionTitle(doc, "29", "Calendar");
  body(doc, "Route: /calendar   \u00B7   Access: all employees\n\nThe company-wide event and scheduling hub. All project deadlines, client meetings, internal milestones, shoots, deliverable due dates, and business events live here in a shared calendar view.");
  h2(doc, "Adding an Event");
  steps(doc, [
    "Click \u201CCalendar\u201D in the sidebar",
    "Click any date on the calendar grid to open the new event form",
    "Enter the event title, date, time, and type",
    "Optionally link the event to a project and assign to a team member",
    "Click \u201CSave\u201D \u2014 the event appears immediately on the calendar",
  ]);
  h2(doc, "Event Types");
  bullets(doc, [
    "Meeting \u2014 client calls, internal team meetings, discovery sessions",
    "Shoot \u2014 photo and video production days",
    "Deadline \u2014 delivery dates, invoice due dates, contract signing deadlines",
    "Review \u2014 internal or client review sessions for deliverables",
    "Other \u2014 anything that doesn't fit the categories above",
  ]);
  h2(doc, "How Calendar Connects to the Rest of AE Hub");
  bullets(doc, [
    "Upcoming events and deadlines appear on the Dashboard in the Upcoming Deadlines panel",
    "Linking a calendar event to a project keeps all scheduling visible in one place",
    "Use the Deadlines page for the prioritized due-date list; use Calendar for the full timeline view of how everything fits together",
  ]);
  callout(doc, "tip", "Add shoots, client meetings, and key delivery dates to the Calendar as soon as they are confirmed. The Dashboard Upcoming Deadlines panel pulls from here, so an empty Calendar means Anthony has no early warning on what's coming.");

  // ── Quick Reference Card ──
  doc.addPage();
  doc.save().rect(0, 0, 612, 792).fillColor(LGRAY).fill().restore();
  doc.save().rect(0, 0, 612, 6).fillColor(BRAND).fill().restore();
  doc.fontSize(20).font("Helvetica-Bold").fillColor(DARK).text("Quick Reference Card", LM, 24, { width: W });
  doc.fontSize(10).font("Helvetica").fillColor(GRAY).text("Common tasks at a glance.", LM, 52, { width: W });
  doc.y = 70;
  hr(doc, doc.y, "#D1D5DB", 1);
  doc.y += 10;

  const qrTaskW = 160;
  const qrPathX = LM + qrTaskW + 6;
  const qrPathW = RM - qrPathX;

  const qrRows: [string, string][] = [
    ["Record a payment",        "Invoices \u2192 Hover row \u2192 Pay \u2192 Select method \u2192 Mark as Paid"],
    ["Create a proposal",       "Proposals \u2192 New Proposal  —OR—  open Estimate \u2192 Create Proposal"],
    ["Send a proposal",         "Proposals \u2192 Open proposal \u2192 change status to Sent"],
    ["Create a contract",       "Contracts \u2192 New Contract  —OR—  open Proposal \u2192 Create Contract"],
    ["Send a contract",         "Contracts \u2192 Open contract \u2192 click Send"],
    ["Invoice from contract",   "Contracts \u2192 Open signed contract \u2192 Create Invoice"],
    ["Share a deliverable",     "Deliverables \u2192 Share Deliverable \u2192 Project, title, URL, email \u2192 Share"],
    ["Add a project task",      "Client Projects \u2192 Card \u2192 New Task \u2192 Title + priority \u2192 Add Task"],
    ["Add an expense",          "Expenses \u2192 Add Expense \u2192 Description, amount, category \u2192 Save"],
    ["Log time",                "Time Tracking \u2192 Log Time \u2192 Project, member, hours \u2192 Save"],
    ["Set up a client portal",  "Client registers at /client \u2192 Admin \u2192 Approvals \u2192 Approve"],
    ["Approve a new user",      "Approvals (red sidebar badge) \u2192 Review \u2192 Approve or Reject"],
    ["Run monthly flash report","Accounting \u2192 select month \u2192 review Collected vs. Forecasted"],
    ["Run an automation scan",  "Automation \u2192 ARIA \u2192 \u201CRun a full opportunity scan\u201D \u2192 review ranked list with ROI"],
    ["Report a system issue",   "IT Department \u2192 NEXUS \u2192 describe what\u2019s broken, exact error, which page, when it started"],
    ["Launch a social campaign","Social Media Dept \u2192 VIBE \u2192 share Sharon\u2019s brief \u2192 Team Campaign Analysis"],
    ["Explore a product idea",  "Inventors \u2192 EINSTEIN \u2192 describe the opportunity \u2192 Team Analysis for full Invention Brief"],
    ["Get a financial analysis", "Geoffrey \u2192 Analysis tab \u2192 ask about margin, tax, cash flow, or upcoming priorities"],
    ["Draft an email",          "Anetta \u2192 \u201CDraft an email to [name] about [topic]\u201D \u2192 review in /anetta/inbox \u2192 approve to send"],
    ["File a document",         "Anetta \u2192 \u201CFile this [document]\u201D \u2192 Anetta proposes folder + name \u2192 admin approves at /anetta/filing"],
    ["Add a calendar event",    "Calendar \u2192 click date \u2192 enter title, type, time \u2192 Save"],
  ];

  qrRows.forEach(([task, path]) => {
    checkPage(doc, 20);
    const y = doc.y;
    doc.fontSize(10).font("Helvetica-Bold");
    const taskH = doc.heightOfString(task, { width: qrTaskW });
    doc.fontSize(10).font("Helvetica");
    const pathH = doc.heightOfString(path, { width: qrPathW });
    const rowH = Math.max(taskH, pathH);
    doc.fontSize(10).font("Helvetica-Bold").fillColor(DARK).text(task, LM, y, { width: qrTaskW });
    doc.fontSize(10).font("Helvetica").fillColor(GRAY).text(path, qrPathX, y, { width: qrPathW });
    doc.y = y + rowH + 3;
    hr(doc, doc.y, "#E5E7EB", 0.5);
    doc.y += 4;
  });

  doc.y += 8;
  doc.fontSize(10).font("Helvetica-Bold").fillColor(DARK).text("Daily Checklist", LM, doc.y, { width: W });
  doc.y += 4;
  bullets(doc, [
    "Dashboard \u2014 check revenue pipeline and Upcoming Deadlines for anything due today",
    "Proposals \u2014 check for any client responses overnight (Accepted or Rejected)",
    "Deliverables \u2014 check the Revisions Requested tab for any client feedback",
    "Time Tracking \u2014 log yesterday's hours before starting new work",
    "Invoices \u2014 note any invoices that became overdue and follow up immediately",
  ]);
}

// ─── CLIENT GUIDE ─────────────────────────────────────────────────────────────
function buildClientGuide(doc: Doc) {

  function addPageNumbersClient(d: Doc) {
    const range = d.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      if (i === 0) continue;
      d.switchToPage(i);
      d.fontSize(8).font("Helvetica").fillColor(GRAY)
        .text("AE Hub Client Portal Guide  \u00B7  Accelerated Experiences LLC", LM, 754, { width: W / 2 + 40, lineBreak: false });
      d.text(`Page ${i}`, LM, 754, { width: W, align: "right", lineBreak: false });
    }
  }

  // Cover
  doc.save().rect(0, 0, 612, 792).fillColor("#7C3AED").fill().restore();
  doc.save().rect(0, 620, 612, 172).fillColor("#4C1D95").fill().restore();
  doc.fontSize(42).font("Helvetica-Bold").fillColor("white").text("AE Hub", LM, 168, { width: W });
  doc.fontSize(20).font("Helvetica").fillColor("rgba(255,255,255,0.72)").text("Client Portal Guide", LM, 222, { width: W });
  doc.save().moveTo(LM, 258).lineTo(LM + 160, 258).strokeColor("rgba(255,255,255,0.25)").lineWidth(1).stroke().restore();
  doc.fontSize(11).font("Helvetica").fillColor("rgba(255,255,255,0.56)")
    .text("Your complete guide to reviewing deliverables, accepting proposals,\nand managing your account through the Accelerated Experiences portal.", LM, 272, { width: W });
  doc.fontSize(9).font("Helvetica").fillColor("rgba(255,255,255,0.38)")
    .text("Accelerated Experiences LLC", LM, 716, { width: W / 2, lineBreak: false });
  doc.text(`${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
    LM, 716, { width: W, align: "right", lineBreak: false });

  const cSection = (num: string, title: string) => sectionTitle(doc, num, title);
  const cH2      = (text: string) => h2(doc, text);
  const cBody    = (text: string) => body(doc, text);
  const cUL      = (items: string[]) => bullets(doc, items);
  const cSteps   = (items: string[]) => steps(doc, items);
  const cTip     = (text: string) => callout(doc, "tip", text);
  const cNote    = (text: string) => callout(doc, "note", text);

  cSection("01", "Welcome to Your Client Portal");
  cBody("The Accelerated Experiences client portal is your private, secure space to review files, accept proposals, view invoices, and track contracts — all in one organized place.");
  cH2("Your Four Portal Tabs");
  cUL([
    "Deliverables — files we've shared with you for review and approval",
    "Proposals — formal quotes we've sent for your acceptance or declination",
    "Invoices — your invoice history with amounts, due dates, and payment status",
    "Contracts — agreements we've sent for your signature and records",
  ]);
  cH2("Your Privacy");
  cBody("Your portal is completely isolated. You only ever see content that Accelerated Experiences has explicitly linked to your email address. You cannot see other clients' files, any financial data from the business side, team information, or anything else internal.");
  cTip("Bookmark the portal URL. We'll reach out when something is ready, but the portal is available 24/7 — you can always log in to check your latest files, proposals, and invoices.");

  cSection("02", "Getting Started");
  cH2("Creating Your Account");
  cSteps([
    "Go to the Accelerated Experiences app URL",
    "Click \"Client portal\" at the bottom of the sign-in page",
    "Click \"Register\" and enter your full name, email address, and a password of your choice",
    "Submit your registration — the team reviews and approves your account",
    "Once approved you can sign in immediately and see all your content",
  ]);
  cNote("Use the same email address that Accelerated Experiences has on file for you. All content is matched to your specific email — if the email doesn't match, items won't appear.");
  cH2("Signing In");
  cSteps([
    "Go to the app URL and click \"Client portal\"",
    "Enter your email and password",
    "Click \"Sign In\" — you'll land on your Deliverables tab",
  ]);
  cH2("Forgotten Password");
  cBody("Contact Accelerated Experiences directly and ask them to reset your client portal password. They can do it quickly from their side.");

  cSection("03", "Deliverables Tab");
  cBody("The Deliverables tab shows every file the Accelerated Experiences team has shared with you, most recent at the top.");
  cH2("Status Badges");
  statusRow(doc, "Awaiting Your Review", AMBER,    "We've shared something new — it needs your response");
  statusRow(doc, "Approved",             GREEN,    "You've already approved this — no further action needed");
  statusRow(doc, "Revision Requested",   BLUE,     "Your feedback was received and sent to our team");
  doc.y += 6;
  cH2("Approving Work");
  cSteps([
    "Find the deliverable with an \"Awaiting Your Review\" badge",
    "Click \"View File\" and carefully review the full file before deciding",
    "If you're satisfied, click the green \"Approve\" button",
    "The status updates immediately to Approved — no further action needed",
  ]);
  cNote("Approvals cannot be reversed from the portal. If you notice something after approving, contact Accelerated Experiences directly and they'll handle it on their end.");
  cH2("Requesting Changes");
  cSteps([
    "Find the deliverable you want to give feedback on",
    "Click \"Request Changes\" — a text box will appear below the action buttons",
    "Write a clear, specific description of what you'd like changed",
    "Click \"Send\" to submit your feedback",
  ]);
  cUL([
    "Be specific — \"lighten the sky in photos 3 and 7\" beats \"adjust the photos\"",
    "List each change as a separate point if there are multiple items",
    "Reference specific timestamps, slide numbers, or photo numbers",
  ]);
  cTip("Take your time reviewing before clicking Approve. Open the file fully and check every detail — you can't un-approve from the portal once it's done.");

  cSection("04", "Proposals Tab");
  cBody("The Proposals tab shows all formal quotes Accelerated Experiences has sent for your review. Each proposal includes a full line-item breakdown of exactly what is included and at what price.");
  cH2("Reviewing a Proposal");
  cSteps([
    "Click on any proposal card to expand the full line-item breakdown",
    "Review the description, quantity, rate, and total for each item",
    "Check the subtotal, tax, and final total at the bottom",
    "Note the validity date — the quote expires after that date",
  ]);
  cH2("Accepting or Declining");
  cSteps([
    "After reviewing the proposal, scroll to the action buttons at the bottom",
    "Click the green \"Accept Proposal\" button to formally accept all terms and pricing",
    "Or click \"Decline\" if you do not wish to proceed",
    "Your response is recorded immediately and the Accelerated Experiences team is notified",
  ]);
  cNote("Accepting a proposal authorizes Accelerated Experiences to proceed with the described work at the stated price. A formal contract will typically follow acceptance for larger projects.");
  cTip("If you have questions about a line item before accepting, contact Accelerated Experiences directly. They can clarify, adjust, and resend the proposal — there is no need to decline and start over.");

  cSection("05", "Invoices Tab");
  cBody("The Invoices tab shows your complete invoice history — every invoice Accelerated Experiences has issued to you, with amounts, due dates, and payment status.");
  cH2("Understanding Your Invoices");
  cUL([
    "Outstanding — the invoice has been issued and is awaiting payment",
    "Paid — payment was received and recorded",
    "Overdue — the due date has passed with no payment recorded",
  ]);
  cH2("Making a Payment");
  cBody("Invoice amounts, due dates, and accepted payment methods are shown on each card. Contact Accelerated Experiences directly to make a payment — the portal is a record-keeping view, not a payment gateway. Payment methods include Bank Transfer, Credit Card, Cash, Check, PayPal, Venmo, Zelle, and Other.");
  cNote("If you see an invoice that looks incorrect — wrong amount, wrong date, or for work you don't recognize — contact Accelerated Experiences immediately. Do not pay an invoice you have not authorized.");
  cTip("Check this tab monthly to keep track of your account balance. Outstanding invoices are listed with their due dates so you can plan payment timing accordingly.");

  cSection("06", "Contracts Tab");
  cBody("The Contracts tab shows all agreements Accelerated Experiences has sent for your records. You can read the full contract text, see when it was sent, and confirm when it was signed.");
  cH2("Reviewing a Contract");
  cSteps([
    "Click on any contract card to expand and read the full contract text",
    "Review all terms, deliverables, and payment conditions carefully",
    "Note the Sent date and any Signed date recorded in the header",
  ]);
  cH2("Signing a Contract");
  cBody("Signing is handled outside the portal — Accelerated Experiences will send you a separate signing link, a physical document, or handle it in person. Once signed, the contract status updates to Signed and the record is confirmed in this tab.");
  cNote("Read every contract fully before signing. If anything is unclear or you want changes, contact Accelerated Experiences before signing — not after.");
  cTip("Keep a personal copy of every signed contract. You can copy the text from the portal, or ask Accelerated Experiences to send you a PDF copy for your own records.");

  cSection("07", "Frequently Asked Questions");
  cH2("I don't see my files after signing in.");
  cBody("Make sure you registered with the exact email address Accelerated Experiences has on file for you. All content is matched by email address. Contact them to confirm which email to use.");
  cH2("My proposal has expired. What do I do?");
  cBody("Contact Accelerated Experiences directly. They can extend the validity date or issue a new proposal with updated pricing if needed.");
  cH2("I don't see an invoice I was expecting.");
  cBody("Invoices are linked directly to your client account. If you are missing an expected invoice, contact Accelerated Experiences and they will verify that the invoice has been assigned to your account.");
  cH2("I accidentally approved a deliverable. Can I undo it?");
  cBody("Approvals cannot be reversed from the portal. Contact Accelerated Experiences directly by email or phone and they'll handle it on their end.");
  cH2("I accepted a proposal but nothing has happened yet.");
  cBody("Accelerated Experiences will follow up with a formal contract and project schedule after acceptance. Typically within one to two business days. If you haven't heard back, contact them directly.");
  cH2("A file link isn't opening.");
  cBody("Try Chrome or Safari. If the file is on Google Drive, make sure you're not signed into a Google account that lacks access. If the link still fails, contact the team and they'll send it another way.");
  cH2("How long does it take to get my account approved?");
  cBody("Typically within one business day. If you've waited more than 24 hours, contact Accelerated Experiences directly to confirm receipt of your registration.");
  cTip("For the fastest help with any portal question, contact Accelerated Experiences directly. We're always happy to help in person or by phone.");

  addPageNumbersClient(doc);
}

// ─── Routes ───────────────────────────────────────────────────────────────────
router.get("/manual/pdf", requireEmployeeAuth, (_req, res) => {
  try {
    const doc = makeDoc();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="ae-hub-user-manual.pdf"');
    doc.pipe(res);
    buildEmployeeManual(doc);
    addPageNumbers(doc);
    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "PDF generation failed" });
  }
});

router.get("/manual/client-pdf", requireEmployeeAuth, (_req, res) => {
  try {
    const doc = makeDoc();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="ae-hub-client-portal-guide.pdf"');
    doc.pipe(res);
    buildClientGuide(doc);
    doc.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "PDF generation failed" });
  }
});

export default router;
