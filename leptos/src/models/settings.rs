use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreset {
    #[default]
    Default,
    Dark,
    Light,
    Cherry,
    Galaxy,
    Ocean,
    RealBlack,
}

impl ThemePreset {
    pub fn name(&self) -> &'static str {
        match self {
            ThemePreset::Default => "default",
            ThemePreset::Dark => "dark",
            ThemePreset::Light => "light",
            ThemePreset::Cherry => "cherry",
            ThemePreset::Galaxy => "galaxy",
            ThemePreset::Ocean => "ocean",
            ThemePreset::RealBlack => "realblack",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            ThemePreset::Default => "Dracula (Default)",
            ThemePreset::Dark => "Dark Minimal",
            ThemePreset::Light => "Light Day",
            ThemePreset::Cherry => "Cherry Rose",
            ThemePreset::Galaxy => "Galaxy Neon",
            ThemePreset::Ocean => "Ocean Depth",
            ThemePreset::RealBlack => "Real Black (OLED)",
        }
    }

    pub fn all() -> &'static [ThemePreset] {
        &[
            ThemePreset::Default,
            ThemePreset::Dark,
            ThemePreset::Light,
            ThemePreset::Cherry,
            ThemePreset::Galaxy,
            ThemePreset::Ocean,
            ThemePreset::RealBlack,
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppSettings {
    pub theme: ThemePreset,
    pub api_base_url: String,
    pub auth_token: Option<String>,
    pub low_memory_mode: bool,
    pub page_size: usize,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreset::Default,
            api_base_url: String::new(),
            auth_token: None,
            low_memory_mode: true,
            page_size: 20,
        }
    }
}
