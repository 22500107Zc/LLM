/**
 * Generates the PDF, DOCX and PPTX fixtures the document tests need, with
 * known content so retrieval can be asserted against specific facts.
 *
 * The files are created deterministically in the requested directory and are
 * regenerated when absent, so a clone with no fixtures still runs.
 */

const path = require("path");
const fs = require("fs");
const { SERVER_DIR } = require("./harness.cjs");

/** Facts deliberately NOT in any fixture, used to test refusal behaviour. */
const ABSENT_FACT_QUESTION =
  "What is the maximum number of API requests per second on the enterprise tier?";

const PDF_FACTS = Object.freeze({
  filename: "refund-policy.pdf",
  question: "How long do I have to request a refund?",
  expectedConcepts: ["30 days refund"],
  lines: [
    "Acme Corporation - Refund Policy",
    "",
    "Customers may request a refund within 30 days of purchase.",
    "A valid receipt is required for all refund requests.",
    "Refunds are issued to the original payment method.",
    "Processing takes 5 to 7 business days after approval.",
    "",
    "Enterprise customers on annual contracts are governed",
    "by the terms of their signed agreement instead.",
  ],
});

const DOCX_FACTS = Object.freeze({
  filename: "support-hours.docx",
  question: "What time does support close?",
  expectedConcepts: ["5pm support"],
  heading: "Acme Corporation - Support Hours",
  paragraphs: [
    "Our support team is available Monday to Friday, 9am to 5pm UK time.",
    "Priority support customers receive a response within 2 hours.",
    "Standard support customers receive a response within 1 business day.",
    "We are closed on UK public holidays.",
  ],
});

const PPTX_FACTS = Object.freeze({
  filename: "onboarding-deck.pptx",
  question: "How long does onboarding take?",
  expectedConcepts: ["14 days onboarding"],
  slides: [
    [
      "Acme Corporation - Customer Onboarding",
      "Onboarding is completed within 14 days of the kickoff call.",
    ],
    [
      "Escalation",
      "Unresolved onboarding issues are escalated to the account manager.",
    ],
  ],
});

/** Loads a dependency from the server workspace, where it is installed. */
function serverModule(name) {
  return require(path.join(SERVER_DIR, "node_modules", name));
}

async function writePdf(target) {
  const { PDFDocument, StandardFonts } = serverModule("pdf-lib");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  PDF_FACTS.lines.forEach((line, index) =>
    page.drawText(line, { x: 50, y: 780 - index * 24, size: 13, font })
  );
  fs.writeFileSync(target, await pdf.save());
}

async function writeDocx(target) {
  const { Document, Packer, Paragraph, HeadingLevel } = serverModule("docx");
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: DOCX_FACTS.heading, heading: HeadingLevel.HEADING_1 }),
          ...DOCX_FACTS.paragraphs.map((text) => new Paragraph(text)),
        ],
      },
    ],
  });
  fs.writeFileSync(target, await Packer.toBuffer(doc));
}

/**
 * A minimal but valid PPTX. This exercises the collector's office-document
 * path (officeparser), which is a different parser from the PDF and DOCX
 * paths and has its own archive-extraction behaviour.
 */
function writePptx(target) {
  const JSZip = serverModule("jszip");
  const zip = new JSZip();

  const slidePaths = PPTX_FACTS.slides.map((_, i) => `/ppt/slides/slide${i + 1}.xml`);
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      slidePaths
        .map(
          (p) =>
            `<Override PartName="${p}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
        )
        .join("") +
      `</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
      `</Relationships>`
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`
  );
  PPTX_FACTS.slides.forEach((lines, index) => {
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
        `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree><p:sp><p:txBody>` +
        lines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join("") +
        `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    );
  });

  return zip
    .generateAsync({ type: "nodebuffer" })
    .then((buffer) => fs.writeFileSync(target, buffer));
}

/**
 * Ensures every fixture exists in `directory` and returns their paths.
 * @param {string} directory
 */
async function ensureFixtures(directory) {
  fs.mkdirSync(directory, { recursive: true });

  const pdfPath = path.join(directory, PDF_FACTS.filename);
  const docxPath = path.join(directory, DOCX_FACTS.filename);
  const pptxPath = path.join(directory, PPTX_FACTS.filename);

  if (!fs.existsSync(pdfPath)) await writePdf(pdfPath);
  if (!fs.existsSync(docxPath)) await writeDocx(docxPath);
  if (!fs.existsSync(pptxPath)) await writePptx(pptxPath);

  return { pdfPath, docxPath, pptxPath, directory };
}

module.exports = {
  ensureFixtures,
  PDF_FACTS,
  DOCX_FACTS,
  PPTX_FACTS,
  ABSENT_FACT_QUESTION,
};
