/**
 * Generates the PDF and DOCX fixtures the document tests need, with known
 * content so retrieval can be asserted against specific facts.
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
 * Ensures both fixtures exist in `directory` and returns their paths.
 * @param {string} directory
 */
async function ensureFixtures(directory) {
  fs.mkdirSync(directory, { recursive: true });

  const pdfPath = path.join(directory, PDF_FACTS.filename);
  const docxPath = path.join(directory, DOCX_FACTS.filename);

  if (!fs.existsSync(pdfPath)) await writePdf(pdfPath);
  if (!fs.existsSync(docxPath)) await writeDocx(docxPath);

  return { pdfPath, docxPath, directory };
}

module.exports = {
  ensureFixtures,
  PDF_FACTS,
  DOCX_FACTS,
  ABSENT_FACT_QUESTION,
};
