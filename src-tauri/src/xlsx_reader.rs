use std::path::{Path, PathBuf};

use calamine::{open_workbook, Data, Range, Reader, Xlsx};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawWorkbookPayload {
    pub sheets: Vec<RawSheetData>,
    pub warnings: Vec<WorkbookWarning>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSheetData {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    pub non_empty_cells: Vec<RawCellData>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RawCellData {
    pub row: u32,
    pub col: u32,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkbookWarning {
    SkippedNonYearSheet { sheet_name: String, reason: String },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReadWorkbookError {
    MissingFile { path: String },
    NonXlsx { path: String },
    OpenFailed { path: String, message: String },
    ReadFailed {
        path: String,
        sheet_name: String,
        message: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
struct ExtractedSheetData {
    rows: Vec<Vec<String>>,
    non_empty_cells: Vec<RawCellData>,
}

#[tauri::command]
pub fn read_xlsx_workbook_raw(path: String) -> Result<RawWorkbookPayload, ReadWorkbookError> {
    let workbook_path = PathBuf::from(&path);

    if !workbook_path.is_file() {
        return Err(ReadWorkbookError::MissingFile { path });
    }

    if !has_xlsx_extension(&workbook_path) {
        return Err(ReadWorkbookError::NonXlsx { path });
    }

    let mut workbook = open_workbook::<Xlsx<_>, _>(&workbook_path).map_err(|error| {
        ReadWorkbookError::OpenFailed {
            path: path.clone(),
            message: error.to_string(),
        }
    })?;

    let mut sheets = Vec::new();
    let mut warnings = Vec::new();

    let sheet_names = workbook
        .sheet_names()
        .iter()
        .map(std::borrow::ToOwned::to_owned)
        .collect::<Vec<String>>();

    for sheet_name in sheet_names {
        if !is_year_sheet_name(&sheet_name) {
            warnings.push(WorkbookWarning::SkippedNonYearSheet {
                sheet_name,
                reason: "sheet name is not a 4-digit year".to_string(),
            });
            continue;
        }

        let range = workbook
            .worksheet_range(&sheet_name)
            .map_err(|error| ReadWorkbookError::ReadFailed {
                path: path.clone(),
                sheet_name: sheet_name.clone(),
                message: error.to_string(),
            })?;

        let extracted = extract_sheet_rows(&range);
        sheets.push(RawSheetData {
            name: sheet_name,
            rows: extracted.rows,
            non_empty_cells: extracted.non_empty_cells,
        });
    }

    Ok(RawWorkbookPayload { sheets, warnings })
}

fn has_xlsx_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xlsx"))
}

fn is_year_sheet_name(sheet_name: &str) -> bool {
    sheet_name.len() == 4 && sheet_name.chars().all(|ch| ch.is_ascii_digit())
}

fn extract_sheet_rows(range: &Range<Data>) -> ExtractedSheetData {
    let (start_row, start_col) = range.start().unwrap_or((0, 0));
    let matrix: Vec<Vec<Data>> = range.rows().map(|row| row.to_vec()).collect();
    extract_rows_from_matrix(&matrix, start_row + 1, start_col + 1)
}

fn extract_rows_from_matrix(
    matrix: &[Vec<Data>],
    first_row_number: u32,
    first_col_number: u32,
) -> ExtractedSheetData {
    let mut rows = Vec::with_capacity(matrix.len());
    let mut non_empty_cells = Vec::new();

    for (row_offset, row) in matrix.iter().enumerate() {
        let mut row_values = Vec::with_capacity(row.len());

        for (col_offset, cell) in row.iter().enumerate() {
            let value = cell_to_string(cell);
            row_values.push(value.clone());

            if !matches!(cell, Data::Empty) {
                non_empty_cells.push(RawCellData {
                    row: first_row_number + row_offset as u32,
                    col: first_col_number + col_offset as u32,
                    value,
                });
            }
        }

        rows.push(row_values);
    }

    ExtractedSheetData {
        rows,
        non_empty_cells,
    }
}

fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        _ => cell.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        extract_rows_from_matrix, is_year_sheet_name, read_xlsx_workbook_raw, RawCellData,
        ReadWorkbookError, WorkbookWarning,
    };
    use calamine::Data;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_path(suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fin-app-xlsx-reader-{nanos}-{}-{suffix}",
            std::process::id()
        ))
    }

    fn fixture_path(file_name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("excel")
            .join(file_name)
    }

    #[test]
    fn year_sheet_name_requires_exactly_four_digits() {
        assert!(is_year_sheet_name("2025"));
        assert!(is_year_sheet_name("1999"));

        assert!(!is_year_sheet_name("25"));
        assert!(!is_year_sheet_name("202A"));
        assert!(!is_year_sheet_name("Summary"));
    }

    #[test]
    fn extract_rows_from_matrix_keeps_cell_strings_and_coordinates() {
        let matrix = vec![
            vec![
                Data::String("Payee".to_string()),
                Data::String("Jan".to_string()),
                Data::Empty,
            ],
            vec![
                Data::String("Water".to_string()),
                Data::String("01/08 $48.58".to_string()),
                Data::Int(2),
            ],
        ];

        let extracted = extract_rows_from_matrix(&matrix, 1, 1);

        assert_eq!(
            extracted.rows,
            vec![
                vec!["Payee".to_string(), "Jan".to_string(), String::new()],
                vec![
                    "Water".to_string(),
                    "01/08 $48.58".to_string(),
                    "2".to_string()
                ]
            ]
        );

        assert_eq!(
            extracted.non_empty_cells,
            vec![
                RawCellData {
                    row: 1,
                    col: 1,
                    value: "Payee".to_string()
                },
                RawCellData {
                    row: 1,
                    col: 2,
                    value: "Jan".to_string()
                },
                RawCellData {
                    row: 2,
                    col: 1,
                    value: "Water".to_string()
                },
                RawCellData {
                    row: 2,
                    col: 2,
                    value: "01/08 $48.58".to_string()
                },
                RawCellData {
                    row: 2,
                    col: 3,
                    value: "2".to_string()
                },
            ]
        );
    }

    #[test]
    fn command_returns_missing_file_error_for_unreadable_path() {
        let missing = unique_test_path("missing.xlsx");
        let result = read_xlsx_workbook_raw(missing.display().to_string());

        assert!(matches!(
            result,
            Err(ReadWorkbookError::MissingFile { path }) if path == missing.display().to_string()
        ));
    }

    #[test]
    fn command_returns_non_xlsx_error_for_wrong_extension() {
        let txt_path = unique_test_path("not-xlsx.txt");
        fs::write(&txt_path, "anything").expect("should create temp file");

        let result = read_xlsx_workbook_raw(txt_path.display().to_string());

        assert!(matches!(
            result,
            Err(ReadWorkbookError::NonXlsx { path }) if path == txt_path.display().to_string()
        ));

        let _ = fs::remove_file(txt_path);
    }

    #[test]
    fn command_returns_open_failed_for_corrupt_xlsx_file() {
        let xlsx_path = unique_test_path("corrupt.xlsx");
        fs::write(&xlsx_path, "not a real xlsx").expect("should create corrupt xlsx file");

        let result = read_xlsx_workbook_raw(xlsx_path.display().to_string());

        match result {
            Err(ReadWorkbookError::OpenFailed { path, .. }) => {
                assert_eq!(path, xlsx_path.display().to_string());
            }
            other => panic!("expected OpenFailed error, got {other:?}"),
        }

        let _ = fs::remove_file(xlsx_path);
    }

    #[test]
    fn command_reads_fixture_year_sheet_and_surfaces_non_year_warning() {
        let fixture = fixture_path("task-02-1-reader.xlsx");
        assert!(fixture.is_file(), "fixture must exist: {}", fixture.display());

        let payload = read_xlsx_workbook_raw(fixture.display().to_string())
            .expect("fixture workbook should load successfully");

        let sheet_names = payload
            .sheets
            .iter()
            .map(|sheet| sheet.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(sheet_names, vec!["2024"]);

        assert_eq!(payload.sheets.len(), 1);
        let year_sheet = &payload.sheets[0];
        assert_eq!(year_sheet.name, "2024");
        assert_eq!(year_sheet.rows.len(), 3);
        assert_eq!(
            year_sheet.rows,
            vec![
                vec!["Payee".to_string(), "Jan".to_string(), "Feb".to_string()],
                vec![
                    "Water".to_string(),
                    "01/08 $48.58".to_string(),
                    String::new(),
                ],
                vec!["Rent".to_string(), String::new(), "1200".to_string()],
            ]
        );

        assert!(!year_sheet.non_empty_cells.is_empty());
        assert!(
            year_sheet
                .non_empty_cells
                .iter()
                .all(|cell| cell.row > 0 && cell.col > 0),
            "all non-empty cells should include 1-based source coordinates"
        );
        assert_eq!(
            year_sheet.non_empty_cells,
            vec![
                RawCellData {
                    row: 1,
                    col: 1,
                    value: "Payee".to_string()
                },
                RawCellData {
                    row: 1,
                    col: 2,
                    value: "Jan".to_string()
                },
                RawCellData {
                    row: 1,
                    col: 3,
                    value: "Feb".to_string()
                },
                RawCellData {
                    row: 2,
                    col: 1,
                    value: "Water".to_string()
                },
                RawCellData {
                    row: 2,
                    col: 2,
                    value: "01/08 $48.58".to_string()
                },
                RawCellData {
                    row: 3,
                    col: 1,
                    value: "Rent".to_string()
                },
                RawCellData {
                    row: 3,
                    col: 3,
                    value: "1200".to_string()
                },
            ]
        );

        assert_eq!(payload.warnings.len(), 1);
        match &payload.warnings[0] {
            WorkbookWarning::SkippedNonYearSheet { sheet_name, reason } => {
                assert_eq!(sheet_name, "Summary");
                assert_eq!(reason, "sheet name is not a 4-digit year");
            }
        }
    }
}
