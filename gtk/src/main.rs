mod asset;
mod cli;
mod lorebook;
mod memory;
mod model;
mod provider;
mod relational;
mod secret;
mod storage;
mod ui;

use adw::prelude::*;

const APPLICATION_ID: &str = "io.risuai.RisuAI.Native";

fn main() -> gtk::glib::ExitCode {
    if let Some(exit_code) = cli::handle() {
        return exit_code;
    }

    let application = adw::Application::builder()
        .application_id(APPLICATION_ID)
        .build();

    application.connect_activate(ui::build);
    application.run()
}
