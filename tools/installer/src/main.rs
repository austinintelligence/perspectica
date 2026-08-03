use clap::{Parser, Subcommand, ValueEnum};
use perspectica_installer::{
    configure_update_schedule, default_install_directory, detect_browsers,
    download_latest_github_release, download_release_asset, install_verified_zip,
    open_install_guidance, platform, print_guidance, remove_update_schedule, uninstall,
    update_marker, Browser, BrowserInstallation,
};
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(
    name = "perspectica-installer",
    about = "Verify and guide installation of Perspectica releases"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum BrowserChoice {
    Chrome,
    Edge,
    Brave,
}

impl BrowserChoice {
    fn browser(self) -> Browser {
        match self {
            Self::Chrome => Browser::Chrome,
            Self::Edge => Browser::Edge,
            Self::Brave => Browser::Brave,
        }
    }
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Detect a browser, open its extensions page, and reveal the unpacked directory.
    Setup {
        #[arg(long, value_enum)]
        browser: Option<BrowserChoice>,
        #[arg(long)]
        destination: Option<PathBuf>,
    },
    /// Verify and install a downloaded ZIP into the fixed unpacked directory.
    Install {
        zip: PathBuf,
        #[arg(long)]
        version: String,
        #[arg(long)]
        sha256: String,
        #[arg(long, default_value = "local ZIP")]
        source: String,
        #[arg(long)]
        destination: Option<PathBuf>,
    },
    /// Download a GitHub release asset, verify SHA256SUMS, and install it.
    DownloadRelease {
        #[arg(long)]
        asset_url: String,
        #[arg(long)]
        checksum_url: String,
        #[arg(long)]
        asset_name: String,
        #[arg(long)]
        version: String,
        #[arg(long)]
        destination: Option<PathBuf>,
    },
    /// Download, verify, and install the newest GitHub developer release.
    UpdateLatest {
        #[arg(long, default_value = "drperky20/perspectica")]
        repository: String,
        #[arg(long)]
        destination: Option<PathBuf>,
    },
    /// Opt in to a login-and-daily developer-channel update check.
    EnableUpdates {
        #[arg(long, default_value = "drperky20/perspectica")]
        repository: String,
    },
    /// Remove the opt-in developer-channel update schedule.
    DisableUpdates,
    /// Print visible browser-specific Load unpacked instructions.
    Guide {
        #[arg(long)]
        destination: Option<PathBuf>,
    },
    /// Reinstall a verified ZIP (repair/update) using the same fixed directory.
    Repair {
        zip: PathBuf,
        #[arg(long)]
        version: String,
        #[arg(long)]
        sha256: String,
        #[arg(long)]
        destination: Option<PathBuf>,
    },
    /// Update only the local marker after an operator has verified metadata.
    UpdateMarker {
        #[arg(long)]
        version: String,
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        destination: Option<PathBuf>,
    },
    /// Remove only a marked Perspectica installation.
    Uninstall {
        #[arg(long)]
        destination: Option<PathBuf>,
    },
}

fn destination(value: Option<PathBuf>) -> PathBuf {
    value.unwrap_or_else(default_install_directory)
}

fn detected_browsers() -> Vec<perspectica_installer::BrowserInstallation> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let program_files = std::env::var_os("PROGRAMFILES").map(PathBuf::from);
    detect_browsers(
        platform(),
        home.as_deref(),
        local_app_data.as_deref(),
        program_files.as_deref(),
    )
}

fn choose_browser(
    detected: &[BrowserInstallation],
    requested: Option<BrowserChoice>,
) -> Option<BrowserInstallation> {
    if let Some(requested) = requested {
        return detected
            .iter()
            .find(|candidate| candidate.browser == requested.browser())
            .cloned();
    }
    if detected.len() <= 1 || !io::stdin().is_terminal() {
        return detected.first().cloned();
    }

    println!("Choose a browser:");
    for (index, candidate) in detected.iter().enumerate() {
        println!("  {}. {}", index + 1, candidate.browser.label());
    }
    print!("Selection [1]: ");
    let _ = io::stdout().flush();
    let mut input = String::new();
    let selected = io::stdin()
        .read_line(&mut input)
        .ok()
        .and_then(|_| input.trim().parse::<usize>().ok())
        .unwrap_or(1);
    detected
        .get(selected.saturating_sub(1))
        .or_else(|| detected.first())
        .cloned()
}

fn setup(
    browser: Option<BrowserChoice>,
    target: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let target = destination(target);
    let browsers = detected_browsers();
    println!("{}", print_guidance(&target, &browsers));
    if let Some(selected) = choose_browser(&browsers, browser) {
        open_install_guidance(&target, &selected)?;
        println!(
            "Opened {} and revealed the extension directory.",
            selected.browser.label()
        );
    } else {
        println!(
            "No supported browser executable was detected. Open Chrome, Edge, or Brave manually."
        );
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        None => setup(None, None)?,
        Some(Command::Setup {
            browser,
            destination: target,
        }) => setup(browser, target)?,
        Some(Command::Install {
            zip,
            version,
            sha256,
            source,
            destination: target,
        }) => {
            let bytes = fs::read(zip)?;
            let target = destination(target);
            install_verified_zip(&bytes, &target, &version, &sha256, &source)?;
            let browsers = detected_browsers();
            println!(
                "Installed verified Perspectica {version} at {}.",
                target.display()
            );
            println!("{}", print_guidance(&target, &browsers));
        }
        Some(Command::Repair {
            zip,
            version,
            sha256,
            destination: target,
        }) => {
            let bytes = fs::read(zip)?;
            let target = destination(target);
            install_verified_zip(&bytes, &target, &version, &sha256, "repair ZIP")?;
            println!(
                "Repaired verified Perspectica {version} at {}.",
                target.display()
            );
            println!("{}", print_guidance(&target, &[]));
        }
        Some(Command::DownloadRelease {
            asset_url,
            checksum_url,
            asset_name,
            version,
            destination: target,
        }) => {
            let (bytes, digest) = download_release_asset(&asset_url, &checksum_url, &asset_name)?;
            let target = destination(target);
            install_verified_zip(&bytes, &target, &version, &digest, &asset_url)?;
            println!(
                "Installed verified Perspectica {version} at {}.",
                target.display()
            );
            println!("{}", print_guidance(&target, &[]));
        }
        Some(Command::UpdateLatest {
            repository,
            destination: target,
        }) => {
            let release = download_latest_github_release(&repository)?;
            let target = destination(target);
            install_verified_zip(
                &release.bytes,
                &target,
                &release.version,
                &release.sha256,
                &release.source_url,
            )?;
            println!(
                "Installed verified Perspectica {} at {}. Reload its browser extension card to apply the update.",
                release.version,
                target.display()
            );
        }
        Some(Command::EnableUpdates { repository }) => {
            let location = configure_update_schedule(&repository)?;
            println!(
                "Enabled explicit developer update checks using {}.",
                location.display()
            );
        }
        Some(Command::DisableUpdates) => {
            remove_update_schedule()?;
            println!("Removed the Perspectica developer update schedule.");
        }
        Some(Command::Guide {
            destination: target,
        }) => {
            let target = destination(target);
            let browsers = detected_browsers();
            println!("{}", print_guidance(&target, &browsers));
        }
        Some(Command::UpdateMarker {
            version,
            source,
            destination: target,
        }) => {
            let marker = update_marker(&destination(target), &version, source.as_deref())?;
            println!("Updated marker for {} ({}).", marker.version, marker.sha256);
        }
        Some(Command::Uninstall {
            destination: target,
        }) => {
            let target = destination(target);
            uninstall(&target)?;
            println!(
                "Removed marked Perspectica installation at {}.",
                target.display()
            );
        }
    }
    Ok(())
}
