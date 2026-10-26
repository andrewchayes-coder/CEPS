import { expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

it('retries a failed first font read on the next request', async () => {
  const { referralPdfText } = await import('./referral-pdf-text');
  vi.mocked(readFile).mockRejectedValueOnce(new Error('Transient first font read failure'));
  await expect(referralPdfText(await PDFDocument.create(), ['Alex Smith'])).rejects.toThrow('Transient first font read failure');
  const pdf = await PDFDocument.create();
  const layout = await referralPdfText(pdf, ['Alex Smith']);
  const page = pdf.addPage();
  for (const run of layout.runs('Alex Smith')) page.drawText(run.text, { font: run.font });
  expect((await pdf.save()).length).toBeGreaterThan(0);
  // First request attempted Regular + Bold; only the failed Regular is retried.
  expect(readFile).toHaveBeenCalledTimes(3);
});
