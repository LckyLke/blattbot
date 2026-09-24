/** Real PDF annotation fixture: named and explicit destinations, including a distant page. */
export function referencePdf(equationPage: 3 | 4 = 4): Buffer {
  const text = (y: number, value: string) => `BT /F1 16 Tf 40 ${y} Td (${value.replace(/([()\\])/g, "\\$1")}) Tj ET`;
  const streams = [
    text(740, "Methodology") + text(700, "Equation (6)") + text(650, "Section 2") + text(600, "Citation [1]") + text(550, "Broken reference") + text(300, "Same-page destination"),
    text(740, "Background"), text(740, "Additional analysis"),
    text(400, "E = mc2 (6)") + text(350, "Return to methodology"),
    text(500, "Bibliography: Example reference [1]"),
  ];
  if (equationPage === 3) [streams[2], streams[3]] = [streams[3], streams[2]];
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [(cite.example) [12 0 R /XYZ 40 500 null] (equation.6) [${equationPage === 3 ? 8 : 10} 0 R /XYZ 40 400 null] (section.method) [4 0 R /XYZ 40 700 null]] >> >> >>`,
    "<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R 10 0 R 12 0 R] /Count 5 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  streams.forEach((stream, i) => {
    const annotations = i === 0 ? "/Annots [14 0 R 15 0 R 16 0 R 17 0 R]" : i === equationPage - 1 ? "/Annots [18 0 R]" : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R ${annotations} >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  const link = (rect: string, dest: string) => `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] /Dest ${dest} >>`;
  objects.push(link("40 696 145 714", "(equation.6)"), link("40 646 120 664", "[4 0 R /XYZ 40 300 null]"),
    link("40 596 130 614", "(cite.example)"), link("40 546 175 564", "(missing)"), link("40 346 220 364", "(section.method)"));
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`, "latin1");
}
