import { mkdir } from "node:fs/promises";
import path from "node:path";

import ExcelJS from "exceljs";

const HEADER_FILL = {
  fgColor: { argb: "FF1F4E78" },
  pattern: "solid",
  type: "pattern",
} as const;

const HEADER_FONT = {
  bold: true,
  color: { argb: "FFFFFFFF" },
} as const;

const STATUS_COLORS = {
  ERRO: "FFFFE5E5",
  OK: "FFE2F0D9",
} as const;

export async function ensureOutputDirectory(outputPath: string) {
  await mkdir(path.dirname(outputPath), { recursive: true });
}

export function createWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "robo-topsun";
  workbook.created = new Date();
  workbook.modified = new Date();

  return workbook;
}

export function applyWorksheetUx(worksheet: ExcelJS.Worksheet) {
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { column: 1, row: 1 },
    to: { column: worksheet.columnCount, row: 1 },
  };

  const headerRow = worksheet.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  worksheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = {
        bottom: { color: { argb: "FFD9EAF7" }, style: "thin" },
        left: { color: { argb: "FFD9EAF7" }, style: "thin" },
        right: { color: { argb: "FFD9EAF7" }, style: "thin" },
        top: { color: { argb: "FFD9EAF7" }, style: "thin" },
      };
    });

    if (rowNumber > 1 && rowNumber % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = {
          fgColor: { argb: "FFF7FBFF" },
          pattern: "solid",
          type: "pattern",
        };
      });
    }
  });
}

export function paintStatusColumn(
  worksheet: ExcelJS.Worksheet,
  columnKey: string
) {
  worksheet.getColumn(columnKey).eachCell((cell, rowNumber) => {
    if (rowNumber === 1 || typeof cell.value !== "string") {
      return;
    }

    cell.fill = {
      fgColor: {
        argb: STATUS_COLORS[cell.value as keyof typeof STATUS_COLORS],
      },
      pattern: "solid",
      type: "pattern",
    };
    cell.font = { bold: true };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
}

export async function writeWorkbook(
  workbook: ExcelJS.Workbook,
  outputPath: string
) {
  await ensureOutputDirectory(outputPath);
  await workbook.xlsx.writeFile(outputPath);
}
