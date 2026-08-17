use printpdf::{
    BuiltinFont, Mm, Op, PdfDocument, PdfFontHandle, PdfPage, PdfSaveOptions, Point, Pt,
    RawImage, TextItem, XObjectTransform,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPdfTableRow {
    pub label: String,
    pub total_cents: i64,
    pub count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPdfSpec {
    pub title: String,
    pub period_label: String,
    pub column_headers: Vec<String>,
    pub table_rows: Vec<ReportPdfTableRow>,
    #[serde(default)]
    pub chart_png_bytes: Option<Vec<u8>>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportReportPdfError {
    WriteFailed { path: String, message: String },
    InvalidChartImage { message: String },
}

const PAGE_WIDTH: Mm = Mm(210.0);
const PAGE_HEIGHT: Mm = Mm(297.0);
const MARGIN_LEFT: Mm = Mm(20.0);
const COL_TOTAL_X: Mm = Mm(120.0);
const COL_COUNT_X: Mm = Mm(165.0);
const LINE_HEIGHT: Mm = Mm(6.0);

fn format_cents(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.unsigned_abs();
    let dollars = abs / 100;
    let cents_part = abs % 100;
    format!("{sign}${dollars}.{cents_part:02}")
}

fn push_text_line(ops: &mut Vec<Op>, text: &str, x: Mm, y: Mm, size: Pt) {
    ops.push(Op::StartTextSection);
    ops.push(Op::SetTextCursor {
        pos: Point::new(x, y),
    });
    ops.push(Op::SetFont {
        font: PdfFontHandle::Builtin(BuiltinFont::Helvetica),
        size,
    });
    ops.push(Op::ShowText {
        items: vec![TextItem::Text(text.to_string())],
    });
    ops.push(Op::EndTextSection);
}

fn build_pdf_bytes(spec: &ReportPdfSpec) -> Result<Vec<u8>, ExportReportPdfError> {
    let mut doc = PdfDocument::new(&spec.title);
    let mut ops = Vec::new();
    let mut y = Mm(270.0);

    push_text_line(&mut ops, &spec.title, MARGIN_LEFT, y, Pt(18.0));
    y -= LINE_HEIGHT * 2.0;
    push_text_line(&mut ops, &spec.period_label, MARGIN_LEFT, y, Pt(12.0));
    y -= LINE_HEIGHT * 2.0;

    if let Some(png_bytes) = spec.chart_png_bytes.as_ref() {
        if !png_bytes.is_empty() {
            let mut warnings = Vec::new();
            let image = RawImage::decode_from_bytes(png_bytes, &mut warnings).map_err(|message| {
                ExportReportPdfError::InvalidChartImage { message }
            })?;
            let image_id = doc.add_image(&image);

            let max_width_mm = 170.0_f32;
            let dpi = 96.0_f32;
            let width_pt = (image.width as f32 / dpi) * 72.0;
            let height_pt = (image.height as f32 / dpi) * 72.0;
            let width_mm = width_pt * 25.4 / 72.0;
            let height_mm = height_pt * 25.4 / 72.0;
            let scale = if width_mm > max_width_mm {
                max_width_mm / width_mm
            } else {
                1.0
            };
            let scaled_height_mm = height_mm * scale;
            y -= Mm(scaled_height_mm + 4.0);

            ops.push(Op::UseXobject {
                id: image_id,
                transform: XObjectTransform {
                    translate_x: Some(Pt(MARGIN_LEFT.0 * 72.0 / 25.4)),
                    translate_y: Some(Pt(y.0 * 72.0 / 25.4)),
                    scale_x: Some(scale),
                    scale_y: Some(scale),
                    dpi: Some(dpi),
                    ..Default::default()
                },
            });
            y -= LINE_HEIGHT;
        }
    }

    let headers = if spec.column_headers.len() >= 3 {
        [
            spec.column_headers[0].as_str(),
            spec.column_headers[1].as_str(),
            spec.column_headers[2].as_str(),
        ]
    } else {
        ["Group", "Total", "Count"]
    };

    push_text_line(&mut ops, headers[0], MARGIN_LEFT, y, Pt(11.0));
    push_text_line(&mut ops, headers[1], COL_TOTAL_X, y, Pt(11.0));
    push_text_line(&mut ops, headers[2], COL_COUNT_X, y, Pt(11.0));
    y -= LINE_HEIGHT;

    for row in &spec.table_rows {
        if y < Mm(20.0) {
            break;
        }
        push_text_line(&mut ops, &row.label, MARGIN_LEFT, y, Pt(10.0));
        push_text_line(
            &mut ops,
            &format_cents(row.total_cents),
            COL_TOTAL_X,
            y,
            Pt(10.0),
        );
        push_text_line(
            &mut ops,
            &row.count.to_string(),
            COL_COUNT_X,
            y,
            Pt(10.0),
        );
        y -= LINE_HEIGHT;
    }

    let page = PdfPage::new(PAGE_WIDTH, PAGE_HEIGHT, ops);
    let mut warnings = Vec::new();
    Ok(doc
        .with_pages(vec![page])
        .save(&PdfSaveOptions::default(), &mut warnings))
}

#[tauri::command]
pub fn export_report_pdf(path: String, spec: ReportPdfSpec) -> Result<(), ExportReportPdfError> {
    let pdf_bytes = build_pdf_bytes(&spec)?;
    write_pdf_file(Path::new(&path), &pdf_bytes)
}

fn write_pdf_file(path: &Path, pdf_bytes: &[u8]) -> Result<(), ExportReportPdfError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| ExportReportPdfError::WriteFailed {
                path: path.display().to_string(),
                message: format!("cannot create parent folder: {error}"),
            })?;
        }
    }

    fs::write(path, pdf_bytes).map_err(|error| ExportReportPdfError::WriteFailed {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_pdf_bytes, export_report_pdf, write_pdf_file, ExportReportPdfError, ReportPdfSpec,
        ReportPdfTableRow,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_path(suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fin-app-report-pdf-{nanos}-{}-{suffix}",
            std::process::id()
        ))
    }

    fn fixture_spec() -> ReportPdfSpec {
        ReportPdfSpec {
            title: "Where the money goes".to_string(),
            period_label: "Calendar year 2026".to_string(),
            column_headers: vec!["Group".to_string(), "Total".to_string(), "Count".to_string()],
            table_rows: vec![
                ReportPdfTableRow {
                    label: "Utilities".to_string(),
                    total_cents: 5_000,
                    count: 1,
                },
                ReportPdfTableRow {
                    label: "Uncategorized".to_string(),
                    total_cents: 1_200,
                    count: 1,
                },
                ReportPdfTableRow {
                    label: "Legacy".to_string(),
                    total_cents: -3_300,
                    count: 2,
                },
            ],
            chart_png_bytes: None,
        }
    }

    fn assert_valid_pdf(bytes: &[u8]) {
        assert!(bytes.starts_with(b"%PDF"));
        let text = String::from_utf8_lossy(bytes);
        assert!(text.contains("%%EOF"));
    }

    #[test]
    fn writes_valid_pdf_for_fixture_spec() {
        let output = unique_test_path("report.pdf");
        export_report_pdf(output.display().to_string(), fixture_spec())
            .expect("export should succeed");

        let bytes = fs::read(&output).expect("pdf file should exist");
        assert_valid_pdf(&bytes);

        let _ = fs::remove_file(output);
    }

    #[test]
    fn formats_known_cents_in_pdf_bytes() {
        let bytes = build_pdf_bytes(&fixture_spec()).expect("pdf bytes should build");
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.contains("$50.00"));
        assert!(text.contains("$12.00"));
        assert!(text.contains("-$33.00"));
    }

    #[test]
    fn writes_valid_pdf_with_fixture_png() {
        let png_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("report")
            .join("chart-mini.png");
        let png_bytes = fs::read(&png_path).expect("fixture png must exist");

        let mut spec = fixture_spec();
        spec.chart_png_bytes = Some(png_bytes);

        let output = unique_test_path("report-with-chart.pdf");
        export_report_pdf(output.display().to_string(), spec).expect("export should succeed");

        let bytes = fs::read(&output).expect("pdf file should exist");
        assert_valid_pdf(&bytes);

        let _ = fs::remove_file(output);
    }

    #[test]
    fn write_failed_for_unwritable_directory() {
        let blocked = unique_test_path("blocked/report.pdf");
        let _ = fs::create_dir_all(blocked.parent().expect("parent"));
        let _ = fs::write(&blocked, b"block");
        let _ = fs::remove_file(&blocked);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(blocked.parent().expect("parent"), fs::Permissions::from_mode(0o444))
                .expect("chmod should succeed");

            let result = write_pdf_file(&blocked, b"%PDF-1.4\n%%EOF");
            assert!(matches!(
                result,
                Err(ExportReportPdfError::WriteFailed { .. })
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
            let result = write_pdf_file(Path::new("/dev/null/report.pdf"), b"%PDF-1.4\n%%EOF");
            assert!(matches!(
                result,
                Err(ExportReportPdfError::WriteFailed { .. })
            ));
        }
    }
}
