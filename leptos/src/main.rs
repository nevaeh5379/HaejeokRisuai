use leptos::prelude::*;
use risuai_frontend::App;

fn main() {
    // Redirect panics to the browser console
    console_error_panic_hook::set_once();

    // Mount root Leptos application to document body
    mount_to_body(|| view! { <App /> });
}
