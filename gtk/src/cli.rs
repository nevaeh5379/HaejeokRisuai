use std::ffi::OsString;
use std::path::PathBuf;

use crate::storage::Repository;

#[derive(Debug, Eq, PartialEq)]
enum Command {
    ImportCopy(PathBuf),
    Help,
}

pub fn handle() -> Option<gtk::glib::ExitCode> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let command = match parse(&args) {
        Ok(Some(command)) => command,
        Ok(None) => return None,
        Err(error) => {
            eprintln!("{error}");
            eprintln!("사용법: risuai-gtk --import-copy <원본.sqlite3>");
            return Some(gtk::glib::ExitCode::FAILURE);
        }
    };

    match command {
        Command::Help => {
            print_help();
            Some(gtk::glib::ExitCode::SUCCESS)
        }
        Command::ImportCopy(source) => match Repository::import_snapshot_to_default(&source) {
            Ok(report) => {
                println!("SQLite 스냅샷 가져오기를 완료했습니다.");
                println!("  원본: {}", source.display());
                println!("  대상: {}", report.destination.display());
                println!("  캐릭터: {}", report.characters);
                println!("  채팅: {}", report.chats);
                println!("  메시지: {}", report.messages);
                Some(gtk::glib::ExitCode::SUCCESS)
            }
            Err(error) => {
                eprintln!("SQLite 스냅샷을 가져오지 못했습니다: {error}");
                Some(gtk::glib::ExitCode::FAILURE)
            }
        },
    }
}

fn parse(args: &[OsString]) -> Result<Option<Command>, String> {
    let Some(first) = args.first() else {
        return Ok(None);
    };
    if first == "--help" || first == "-h" {
        return Ok(Some(Command::Help));
    }
    if first != "--import-copy" {
        return Ok(None);
    }
    let source = args
        .get(1)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "--import-copy에는 원본 SQLite 경로가 필요합니다.".to_owned())?;
    if args.len() > 2 {
        return Err("--import-copy에는 원본 경로 하나만 지정할 수 있습니다.".into());
    }
    Ok(Some(Command::ImportCopy(PathBuf::from(source))))
}

fn print_help() {
    println!("RisuAI Native GTK");
    println!();
    println!("사용법:");
    println!("  risuai-gtk                         네이티브 앱 실행");
    println!("  risuai-gtk --import-copy <DB>      기존 DB를 읽기 전용 스냅샷으로 가져오기");
    println!();
    println!("가져오기는 원본을 수정하지 않으며 기존 네이티브 DB를 덮어쓰지 않습니다.");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn regular_application_arguments_are_left_for_gtk() {
        assert_eq!(parse(&arguments(&["--gapplication-service"])), Ok(None));
    }

    #[test]
    fn import_requires_exactly_one_source() {
        assert!(parse(&arguments(&["--import-copy"])).is_err());
        assert!(parse(&arguments(&["--import-copy", "one.db", "two.db"])).is_err());
        assert_eq!(
            parse(&arguments(&["--import-copy", "source.db"])),
            Ok(Some(Command::ImportCopy(PathBuf::from("source.db"))))
        );
    }
}
