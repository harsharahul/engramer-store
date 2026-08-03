/**
 * Empty documents, so a new spreadsheet or Word file can be created here
 * rather than uploaded from somewhere else.
 *
 * These are the smallest valid OOXML packages the editor accepts: a page
 * with one empty paragraph, and a workbook with one empty sheet. The editor
 * fills in everything else the first time the document is saved, so there
 * is no need to ship a fully furnished template.
 */

const BLANK_DOCX_BASE64 =
  "UEsDBBQAAAAIACakAl3JTxqw6wAAAK4BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QvU7DMBDeeQrLK4odGBBCSTrwMwJD" +
  "eYCTfUks7LPlc0v79jht6YAK4933q69b7YIXW8zsIvXyRrVSIJloHU29/Fi/NPdScAGy4CNhL/fIcjVcdet9QhZVTNzLuZT0" +
  "oDWbGQOwigmpImPMAUo986QTmE+YUN+27Z02kQpSacriIYfuCUfY+CKed/V9LJLRsxSPR+KS1UtIyTsDpeJ6S/ZXSnNKUFV5" +
  "4PDsEl9XgtQXExbk74CT7q0uk51F8Q65vEKoLP0Vs9U2mk2oSvW/zYWecRydwbN+cUs5GmSukwevzkgARz/99WHu4RtQSwME" +
  "FAAAAAgAJqQCXbmBRHGwAAAAKgEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4J1TRN5pWgaEUJMuCKkrKgeIEjeNaB5KwqO3" +
  "JwMDIAZG278/y233sDO5YUzGOwZNVQNBJ70yTjM4D8f1DkjKwikxe4cMFkzQ8VV7wlnkspMmExIpiEsMppzDntIkJ7QiVT6g" +
  "K5PRRytyKaOmQciL0Eg3db2l8d0A/mGSXjGIvWqADEvAf2w/jkbiwcurRZd/nPhKFFlEjZnB3UdF1atdFRYob+nHi/wJUEsD" +
  "BBQAAAAIACakAl1NDrmmygAAACkBAAARAAAAd29yZC9kb2N1bWVudC54bWxFT8FuwjAMvfMVUe7DpWIIVbTcdkOatPEBITFt" +
  "pSaOErOMff1cEOrF9vN7es8+HH/9pH4w5ZFCqzfrSisMltwY+lafvz/e9lplNsGZiQK2+o5ZH7vVoTSO7M1jYCUOITel1QNz" +
  "bACyHdCbvKaIQbgrJW9YYOqhUHIxkcWcJcBPUFfVDrwZg+7E8kLuPvcIc81o+TM9cP/1p8ocsanrrZxYmkHm973M8BScTJIt" +
  "U5T99ilJYz/wAi/ETH7BE15frHjAkgevQ2B5svsHUEsBAhQDFAAAAAgAJqQCXclPGrDrAAAArgEAABMAAAAAAAAAAAAAAIAB" +
  "AAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACAAmpAJduYFEcbAAAAAqAQAACwAAAAAAAAAAAAAAgAEcAQAAX3Jl" +
  "bHMvLnJlbHNQSwECFAMUAAAACAAmpAJdTQ65psoAAAApAQAAEQAAAAAAAAAAAAAAgAH1AQAAd29yZC9kb2N1bWVudC54bWxQ" +
  "SwUGAAAAAAMAAwC5AAAA7gIAAAAA";

const BLANK_XLSX_BASE64 =
  "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" +
  "BQAFAEUBAACbBAAAAAA=";

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function decode(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

export function blankDocument(kind: "docx" | "xlsx"): Uint8Array {
  return decode(kind === "docx" ? BLANK_DOCX_BASE64 : BLANK_XLSX_BASE64);
}
