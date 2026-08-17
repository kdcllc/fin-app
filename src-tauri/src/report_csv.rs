use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportReportCsvError {
    WriteFailed { path: String, message: String },
}

#[tauri::command]
pub fn export_report_csv(path: String, content: String) -> Result<(), ExportReportCsvError> {
    write_csv_file(Path::new(&path), content.as_bytes())
}

pub(crate) fn write_csv_file(path: &Path, bytes: &[u8]) -> Result<(), ExportReportCsvError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|error| ExportReportCsvError::WriteFailed {
                path: path.display().to_string(),
                message: format!("cannot create parent folder: {error}"),
            })?;
        }
    }

    fs::write(path, bytes).map_err(|error| ExportReportCsvError::WriteFailed {
        path: path.display().to_string(),
        message: error.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{export_report_csv, write_csv_file, ExportReportCsvError};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_test_path(suffix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fin-app-report-csv-{nanos}-{}-{suffix}",
            std::process::id()
        ))
    }

    #[test]
    fn writes_utf8_csv_bytes_including_bom() {
        let output = unique_test_path("report.csv");
        let content = "\u{feff}Group,Total,Count\r\nUtilities,50.00,1\r\n";
        export_report_csv(output.display().to_string(), content.to_string())
            .expect("export should succeed");

        let bytes = fs::read(&output).expect("csv file should exist");
        assert_eq!(bytes, content.as_bytes());

        let _ = fs::remove_file(output);
    }

    #[test]
    fn write_failed_for_unwritable_directory() {
        let blocked = unique_test_path("blocked/report.csv");
        let _ = fs::create_dir_all(blocked.parent().expect("parent"));
        let _ = fs::write(&blocked, b"block");
        let _ = fs::remove_file(&blocked);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(blocked.parent().expect("parent"), fs::Permissions::from_mode(0o444))
                .expect("chmod should succeed");

            let result = write_csv_file(&blocked, b"\xef\xbb\xbftest\r\n");
            assert!(matches!(
                result,
                Err(ExportReportCsvError::WriteFailed { .. })
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
            let result = write_csv_file(Path::new("/dev/null/report.csv"), b"test\r\n");
            assert!(matches!(
                result,
                Err(ExportReportCsvError::WriteFailed { .. })
            ));
        }
    }
}
