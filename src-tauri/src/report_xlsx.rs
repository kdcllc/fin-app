use rust_xlsxwriter::{ExcelDateTime, Format, Workbook, XlsxError};
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportXlsxSpec {
    pub sheet_name: String,
    pub headers: Vec<String>,
    pub rows: Vec<ReportXlsxRow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportXlsxRow {
    pub cells: Vec<XlsxCell>,
}

/// `rename_all` renames only the variant tags (`kind`); `rename_all_fields` is what
/// maps the UI's camelCase fields (`amountCents`) onto the Rust snake_case ones.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum XlsxCell {
    Text { value: String },
    Date { iso: String },
    Cents { amount_cents: i64 },
    Integer { value: i64 },
}

#[derive(Debug, serde::Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportReportXlsxError {
    WriteFailed { path: String, message: String },
    BuildFailed { message: String },
}

fn cents_to_excel_number(cents: i64) -> f64 {
    let sign = if cents < 0 { -1.0 } else { 1.0 };
    let abs = cents.unsigned_abs();
    let dollars = abs / 100;
    let remainder = abs % 100;
    sign * (dollars as f64 + remainder as f64 / 100.0)
}

fn parse_iso_date(iso: &str) -> Result<ExcelDateTime, ExportReportXlsxError> {
    let bytes = iso.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return Err(ExportReportXlsxError::BuildFailed {
            message: format!("invalid ISO date: {iso}"),
        });
    }

    let year: u16 = iso[0..4]
        .parse()
        .map_err(|_| ExportReportXlsxError::BuildFailed {
            message: format!("invalid ISO date year: {iso}"),
        })?;
    let month: u8 = iso[5..7]
        .parse()
        .map_err(|_| ExportReportXlsxError::BuildFailed {
            message: format!("invalid ISO date month: {iso}"),
        })?;
    let day: u8 = iso[8..10]
        .parse()
        .map_err(|_| ExportReportXlsxError::BuildFailed {
            message: format!("invalid ISO date day: {iso}"),
        })?;

    ExcelDateTime::from_ymd(year, month, day).map_err(|error| ExportReportXlsxError::BuildFailed {
        message: error.to_string(),
    })
}

fn build_xlsx_bytes(spec: &ReportXlsxSpec) -> Result<Vec<u8>, ExportReportXlsxError> {
    let mut workbook = Workbook::new();
    let worksheet = workbook
        .add_worksheet()
        .set_name(&spec.sheet_name)
        .map_err(|error| ExportReportXlsxError::BuildFailed {
            message: error.to_string(),
        })?;

    let date_format = Format::new().set_num_format("yyyy-mm-dd");
    let amount_format = Format::new().set_num_format("0.00");

    for (col, header) in spec.headers.iter().enumerate() {
        worksheet
            .write_string(0, col as u16, header)
            .map_err(map_xlsx_error)?;
    }

    for (row_index, row) in spec.rows.iter().enumerate() {
        let excel_row = (row_index + 1) as u32;
        for (col, cell) in row.cells.iter().enumerate() {
            let excel_col = col as u16;
            match cell {
                XlsxCell::Text { value } => {
                    worksheet
                        .write_string(excel_row, excel_col, value)
                        .map_err(map_xlsx_error)?;
                }
                XlsxCell::Date { iso } => {
                    let date = parse_iso_date(iso)?;
                    worksheet
                        .write_datetime_with_format(excel_row, excel_col, &date, &date_format)
                        .map_err(map_xlsx_error)?;
                }
                XlsxCell::Cents { amount_cents } => {
                    worksheet
                        .write_number_with_format(
                            excel_row,
                            excel_col,
                            cents_to_excel_number(*amount_cents),
                            &amount_format,
                        )
                        .map_err(map_xlsx_error)?;
                }
                XlsxCell::Integer { value } => {
                    worksheet
                        .write_number(excel_row, excel_col, *value as f64)
                        .map_err(map_xlsx_error)?;
                }
            }
        }
    }

    workbook
        .save_to_buffer()
        .map_err(|error| ExportReportXlsxError::BuildFailed {
            message: error.to_string(),
        })
}

fn map_xlsx_error(error: XlsxError) -> ExportReportXlsxError {
    ExportReportXlsxError::BuildFailed {
        message: error.to_string(),
    }
}

#[tauri::command]
pub fn export_report_xlsx(path: String, spec: ReportXlsxSpec) -> Result<(), ExportReportXlsxError> {
    let xlsx_bytes = build_xlsx_bytes(&spec)?;
    write_xlsx_file(Path::new(&path), &xlsx_bytes)
}

fn write_xlsx_file(path: &Path, xlsx_bytes: &[u8]) -> Result<(), ExportReportXlsxError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| ExportReportXlsxError::WriteFailed {
                path: path.display().to_string(),
                message: format!("cannot create parent folder: {error}"),
            })?;
        }
    }

    fs::write(path, xlsx_bytes).map_err(|error| ExportReportXlsxError::WriteFailed {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_xlsx_bytes, cents_to_excel_number, export_report_xlsx, parse_iso_date,
        ExportReportXlsxError, ReportXlsxRow, ReportXlsxSpec, XlsxCell,
    };
    use calamine::{open_workbook, Data, Reader, Xlsx};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_path(suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fin-app-report-xlsx-{nanos}-{}-{suffix}",
            std::process::id()
        ))
    }

    fn excel_number_to_cents(value: f64) -> i64 {
        let sign = if value < 0.0 { -1 } else { 1 };
        let abs = value.abs();
        let dollars = abs.trunc() as i64;
        let cents = ((abs - dollars as f64) * 100.0).round() as i64;
        sign * (dollars * 100 + cents)
    }

    fn read_sheet_matrix(path: &PathBuf) -> Vec<Vec<Data>> {
        let mut workbook =
            open_workbook::<Xlsx<_>, _>(path).expect("written xlsx should open with calamine");
        let sheet_names = workbook.sheet_names().to_owned();
        let first = sheet_names
            .first()
            .expect("workbook should have at least one sheet");
        workbook
            .worksheet_range(first)
            .expect("sheet range should load")
            .rows()
            .map(|row| row.to_vec())
            .collect()
    }

    fn report_table_fixture_spec() -> ReportXlsxSpec {
        ReportXlsxSpec {
            sheet_name: "Report".to_string(),
            headers: vec![
                "Group".to_string(),
                "Total".to_string(),
                "Count".to_string(),
            ],
            rows: vec![
                ReportXlsxRow {
                    cells: vec![
                        XlsxCell::Text {
                            value: "Utilities".to_string(),
                        },
                        XlsxCell::Cents {
                            amount_cents: 5_000,
                        },
                        XlsxCell::Integer { value: 1 },
                    ],
                },
                ReportXlsxRow {
                    cells: vec![
                        XlsxCell::Text {
                            value: "Uncategorized".to_string(),
                        },
                        XlsxCell::Cents {
                            amount_cents: 1_200,
                        },
                        XlsxCell::Integer { value: 1 },
                    ],
                },
                ReportXlsxRow {
                    cells: vec![
                        XlsxCell::Text {
                            value: "Legacy".to_string(),
                        },
                        XlsxCell::Cents {
                            amount_cents: -3_300,
                        },
                        XlsxCell::Integer { value: 2 },
                    ],
                },
            ],
        }
    }

    fn payments_fixture_spec() -> ReportXlsxSpec {
        ReportXlsxSpec {
            sheet_name: "Payments".to_string(),
            headers: vec![
                "Date".to_string(),
                "Payee".to_string(),
                "Account".to_string(),
                "Category".to_string(),
                "Amount".to_string(),
                "Memo".to_string(),
            ],
            rows: vec![
                ReportXlsxRow {
                    cells: vec![
                        XlsxCell::Date {
                            iso: "2026-01-10".to_string(),
                        },
                        XlsxCell::Text {
                            value: "Power Co".to_string(),
                        },
                        XlsxCell::Text {
                            value: "Checking".to_string(),
                        },
                        XlsxCell::Text {
                            value: "Utilities".to_string(),
                        },
                        XlsxCell::Cents {
                            amount_cents: 5_000,
                        },
                        XlsxCell::Text {
                            value: String::new(),
                        },
                    ],
                },
                ReportXlsxRow {
                    cells: vec![
                        XlsxCell::Date {
                            iso: "2026-02-01".to_string(),
                        },
                        XlsxCell::Text {
                            value: "Power Co".to_string(),
                        },
                        XlsxCell::Text {
                            value: "Checking".to_string(),
                        },
                        XlsxCell::Text {
                            value: "Uncategorized".to_string(),
                        },
                        XlsxCell::Cents {
                            amount_cents: 1_200,
                        },
                        XlsxCell::Text {
                            value: String::new(),
                        },
                    ],
                },
            ],
        }
    }

    fn year_sheet_fixture_spec() -> ReportXlsxSpec {
        let month_headers = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        let mut headers = vec!["Payee".to_string()];
        headers.extend(month_headers.iter().map(|month| (*month).to_string()));
        headers.push("Total".to_string());

        let mut payee_months = vec![0_i64; 12];
        payee_months[0] = 4_005;
        payee_months[1] = 2_000;
        payee_months[10] = 995;
        let payee_row_total = payee_months.iter().sum::<i64>();

        let mut month_totals = vec![0_i64; 12];
        for (index, cents) in payee_months.iter().enumerate() {
            month_totals[index] = *cents;
        }
        let grand_total = month_totals.iter().sum::<i64>();

        fn cents_cells(values: &[i64]) -> Vec<XlsxCell> {
            values
                .iter()
                .map(|amount_cents| XlsxCell::Cents {
                    amount_cents: *amount_cents,
                })
                .collect()
        }

        ReportXlsxSpec {
            sheet_name: "2026".to_string(),
            headers,
            rows: vec![
                ReportXlsxRow {
                    cells: {
                        let mut cells = vec![XlsxCell::Text {
                            value: "Power Co".to_string(),
                        }];
                        cells.extend(cents_cells(&payee_months));
                        cells.push(XlsxCell::Cents {
                            amount_cents: payee_row_total,
                        });
                        cells
                    },
                },
                ReportXlsxRow {
                    cells: {
                        let mut cells = vec![XlsxCell::Text {
                            value: "Month Total".to_string(),
                        }];
                        cells.extend(cents_cells(&month_totals));
                        cells.push(XlsxCell::Cents {
                            amount_cents: grand_total,
                        });
                        cells
                    },
                },
            ],
        }
    }

    #[test]
    fn cents_to_excel_number_uses_integer_split() {
        assert_eq!(cents_to_excel_number(5_000), 50.0);
        assert_eq!(cents_to_excel_number(1_200), 12.0);
        assert_eq!(cents_to_excel_number(-3_300), -33.0);
        assert_eq!(cents_to_excel_number(12_345), 123.45);
    }

    #[test]
    fn report_table_xlsx_round_trips_fixture_cents_with_calamine() {
        let output = unique_test_path("report-table.xlsx");
        export_report_xlsx(output.display().to_string(), report_table_fixture_spec())
            .expect("export should succeed");

        let matrix = read_sheet_matrix(&output);
        assert_eq!(matrix.len(), 4);

        let expected = [5_000_i64, 1_200, -3_300];
        for (index, cents) in expected.iter().enumerate() {
            match &matrix[index + 1][1] {
                Data::Float(value) => assert_eq!(excel_number_to_cents(*value), *cents),
                other => panic!("expected numeric total cell, got {other:?}"),
            }
        }

        let _ = fs::remove_file(output);
    }

    fn cell_as_excel_serial(cell: &Data) -> f64 {
        match cell {
            Data::DateTime(value) => value.as_f64(),
            Data::Float(value) => *value,
            other => panic!("expected date cell, got {other:?}"),
        }
    }

    fn cell_as_string(cell: &Data) -> String {
        match cell {
            Data::String(value) => value.clone(),
            Data::Empty => String::new(),
            other => panic!("expected string cell, got {other:?}"),
        }
    }

    fn cell_as_cents(cell: &Data) -> i64 {
        match cell {
            Data::Float(value) => excel_number_to_cents(*value),
            other => panic!("expected numeric cell, got {other:?}"),
        }
    }

    #[test]
    fn payments_xlsx_round_trips_dump_columns_with_calamine() {
        let output = unique_test_path("payments.xlsx");
        export_report_xlsx(output.display().to_string(), payments_fixture_spec())
            .expect("export should succeed");

        let matrix = read_sheet_matrix(&output);
        assert_eq!(matrix.len(), 3);

        let expected_rows = [
            (
                46_032.0,
                "Power Co",
                "Checking",
                "Utilities",
                5_000_i64,
            ),
            (
                46_054.0,
                "Power Co",
                "Checking",
                "Uncategorized",
                1_200_i64,
            ),
        ];

        for (row_index, (date_serial, payee, account, category, amount_cents)) in
            expected_rows.iter().enumerate()
        {
            let row = &matrix[row_index + 1];
            assert_eq!(cell_as_excel_serial(&row[0]), *date_serial);
            assert_eq!(cell_as_string(&row[1]), *payee);
            assert_eq!(cell_as_string(&row[2]), *account);
            assert_eq!(cell_as_string(&row[3]), *category);
            assert_eq!(cell_as_cents(&row[4]), *amount_cents);
        }

        let _ = fs::remove_file(output);
    }

    #[test]
    fn year_sheet_xlsx_round_trips_month_and_grand_totals_with_calamine() {
        let spec = year_sheet_fixture_spec();
        let payee_months = [4_005_i64, 2_000, 0, 0, 0, 0, 0, 0, 0, 0, 995, 0];
        let row_and_grand_total = payee_months.iter().sum::<i64>();

        let output = unique_test_path("year-sheet.xlsx");
        export_report_xlsx(output.display().to_string(), spec)
            .expect("export should succeed");

        let matrix = read_sheet_matrix(&output);
        assert_eq!(matrix.len(), 3);
        assert_eq!(matrix[0].len(), 14);

        let payee_row = &matrix[1];
        assert_eq!(cell_as_string(&payee_row[0]), "Power Co");

        for (month_index, cents) in payee_months.iter().enumerate() {
            assert_eq!(cell_as_cents(&payee_row[month_index + 1]), *cents);
        }
        assert_eq!(cell_as_cents(&payee_row[13]), row_and_grand_total);

        let month_total_row = &matrix[2];
        assert_eq!(cell_as_string(&month_total_row[0]), "Month Total");
        for (month_index, cents) in payee_months.iter().enumerate() {
            assert_eq!(cell_as_cents(&month_total_row[month_index + 1]), *cents);
        }
        assert_eq!(cell_as_cents(&month_total_row[13]), row_and_grand_total);

        let spec = year_sheet_fixture_spec();
        let payee_spec = &spec.rows[0];
        let month_total_spec = &spec.rows[1];
        for (month_index, cell) in payee_spec.cells.iter().skip(1).take(12).enumerate() {
            let XlsxCell::Cents { amount_cents } = cell else {
                panic!("expected cents cell in payee row");
            };
            assert_eq!(*amount_cents, payee_months[month_index]);
        }
        let XlsxCell::Cents {
            amount_cents: payee_row_total,
        } = payee_spec.cells.last().expect("payee row total")
        else {
            panic!("expected payee row total cents");
        };
        assert_eq!(*payee_row_total, row_and_grand_total);

        for (month_index, cell) in month_total_spec.cells.iter().skip(1).take(12).enumerate() {
            let XlsxCell::Cents { amount_cents } = cell else {
                panic!("expected cents cell in month total row");
            };
            assert_eq!(*amount_cents, payee_months[month_index]);
        }
        let XlsxCell::Cents {
            amount_cents: grand_total,
        } = month_total_spec.cells.last().expect("month total grand total")
        else {
            panic!("expected grand total cents");
        };
        assert_eq!(*grand_total, row_and_grand_total);

        let _ = fs::remove_file(output);
    }

    /// The exact `invoke("export_report_xlsx", …)` arguments the UI sends, pinned by
    /// tests/report-xlsx-ipc.test.ts. Deserializing them here catches field-name drift
    /// between src/report-xlsx.ts and this module (B81: `amountCents` vs `amount_cents`).
    const IPC_PAYLOAD: &str = include_str!("../../tests/fixtures/report/xlsx-ipc-payload.json");

    fn ipc_fixture_spec(key: &str) -> ReportXlsxSpec {
        let payload: serde_json::Value =
            serde_json::from_str(IPC_PAYLOAD).expect("fixture should be valid JSON");
        serde_json::from_value(payload[key]["spec"].clone())
            .expect("UI payload should deserialize into ReportXlsxSpec")
    }

    #[test]
    fn ipc_payload_fixture_deserializes_every_cell_kind() {
        let payments = ipc_fixture_spec("payments");
        assert_eq!(payments.sheet_name, "Payments");
        let cells = &payments.rows[0].cells;
        assert!(matches!(&cells[0], XlsxCell::Date { iso } if iso == "2026-02-14"));
        assert!(matches!(&cells[1], XlsxCell::Text { value } if value == "Payee One"));
        assert!(matches!(
            cells[4],
            XlsxCell::Cents {
                amount_cents: -4567
            }
        ));

        let table = ipc_fixture_spec("table");
        let cells = &table.rows[0].cells;
        assert!(matches!(
            cells[1],
            XlsxCell::Cents {
                amount_cents: 12_345
            }
        ));
        assert!(matches!(cells[2], XlsxCell::Integer { value: 3 }));
    }

    #[test]
    fn ipc_payload_fixture_exports_exact_cents() {
        let output = unique_test_path("ipc-payments.xlsx");
        export_report_xlsx(output.display().to_string(), ipc_fixture_spec("payments"))
            .expect("export of the UI payload should succeed");

        let matrix = read_sheet_matrix(&output);
        assert_eq!(cell_as_string(&matrix[1][1]), "Payee One");
        assert_eq!(cell_as_cents(&matrix[1][4]), -4567);

        let _ = fs::remove_file(output);
    }

    #[test]
    fn build_xlsx_bytes_produces_non_empty_buffer() {
        let bytes = build_xlsx_bytes(&report_table_fixture_spec()).expect("xlsx bytes should build");
        assert!(bytes.starts_with(b"PK"));
    }

    #[test]
    fn parse_iso_date_rejects_invalid_values() {
        assert!(parse_iso_date("2026-13-01").is_err());
        assert!(parse_iso_date("bad-date").is_err());
    }

    #[test]
    fn write_failed_for_unwritable_directory() {
        let blocked = unique_test_path("blocked/report.xlsx");
        let _ = fs::create_dir_all(blocked.parent().expect("parent"));
        let bytes = build_xlsx_bytes(&report_table_fixture_spec()).expect("bytes should build");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(blocked.parent().expect("parent"), fs::Permissions::from_mode(0o444))
                .expect("chmod should succeed");

            let result = super::write_xlsx_file(&blocked, &bytes);
            assert!(matches!(
                result,
                Err(ExportReportXlsxError::WriteFailed { .. })
            ));

            fs::set_permissions(
                blocked.parent().expect("parent"),
                fs::Permissions::from_mode(0o755),
            )
            .expect("restore permissions");
            let _ = fs::remove_dir_all(blocked.parent().expect("parent"));
        }

        #[cfg(not(unix))]
        {
            let result = super::write_xlsx_file(Path::new("/dev/null/report.xlsx"), &bytes);
            assert!(matches!(
                result,
                Err(ExportReportXlsxError::WriteFailed { .. })
            ));
        }
    }
}
