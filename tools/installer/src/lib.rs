use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use zip::ZipArchive;

const MARKER_FILE: &str = ".perspectica-install.json";
const MAX_RELEASE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CHECKSUM_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Error)]
pub enum InstallerError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("invalid release archive: {0}")]
    Archive(String),
    #[error("checksum mismatch: expected {expected}, got {actual}")]
    Checksum { expected: String, actual: String },
    #[error("invalid checksum manifest: {0}")]
    ChecksumManifest(String),
    #[error("invalid installation marker: {0}")]
    Marker(#[from] serde_json::Error),
    #[error("HTTP request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("release URLs must use HTTPS: {0}")]
    InsecureUrl(String),
    #[error("release response exceeds the {limit}-byte limit")]
    ResponseTooLarge { limit: u64 },
    #[error("could not launch browser guidance: {0}")]
    Launch(String),
    #[error("invalid GitHub repository identifier: {0}")]
    Repository(String),
    #[error("release metadata is incomplete: {0}")]
    ReleaseMetadata(String),
    #[error("automatic developer updates are not supported on this operating system")]
    UnsupportedPlatform,
    #[error("operating-system update scheduler failed: {0}")]
    Scheduler(String),
    #[error("refusing to remove a directory without a Perspectica marker")]
    UninstallMarkerMissing,
}

pub type Result<T> = std::result::Result<T, InstallerError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Macos,
    Windows,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Browser {
    Chrome,
    Edge,
    Brave,
}

impl Browser {
    pub fn label(self) -> &'static str {
        match self {
            Self::Chrome => "Chrome",
            Self::Edge => "Edge",
            Self::Brave => "Brave",
        }
    }

    pub fn extensions_url(self) -> &'static str {
        match self {
            Self::Chrome => "chrome://extensions",
            Self::Edge => "edge://extensions",
            Self::Brave => "brave://extensions",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserInstallation {
    pub browser: Browser,
    pub executable: Option<PathBuf>,
    pub profile_directory: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallMarker {
    pub schema_version: u8,
    pub version: String,
    pub sha256: String,
    pub source: String,
    pub installed_at_unix_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadedRelease {
    pub version: String,
    pub asset_name: String,
    pub source_url: String,
    pub sha256: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Copy)]
struct BrowserCandidate {
    browser: Browser,
    profile_suffix: &'static str,
    executable_suffixes: &'static [&'static str],
}

const MAC_CANDIDATES: &[BrowserCandidate] = &[
    BrowserCandidate {
        browser: Browser::Chrome,
        profile_suffix: "Library/Application Support/Google/Chrome/Default",
        executable_suffixes: &["Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    },
    BrowserCandidate {
        browser: Browser::Edge,
        profile_suffix: "Library/Application Support/Microsoft Edge/Default",
        executable_suffixes: &["Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    },
    BrowserCandidate {
        browser: Browser::Brave,
        profile_suffix: "Library/Application Support/BraveSoftware/Brave-Browser/Default",
        executable_suffixes: &["Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
    },
];

const WINDOWS_CANDIDATES: &[BrowserCandidate] = &[
    BrowserCandidate {
        browser: Browser::Chrome,
        profile_suffix: "Google/Chrome/User Data/Default",
        executable_suffixes: &[
            "Google/Chrome/Application/chrome.exe",
            "Google/Chrome/chrome.exe",
        ],
    },
    BrowserCandidate {
        browser: Browser::Edge,
        profile_suffix: "Microsoft/Edge/User Data/Default",
        executable_suffixes: &["Microsoft/Edge/Application/msedge.exe"],
    },
    BrowserCandidate {
        browser: Browser::Brave,
        profile_suffix: "BraveSoftware/Brave-Browser/User Data/Default",
        executable_suffixes: &["BraveSoftware/Brave-Browser/Application/brave.exe"],
    },
];

fn candidates(platform: Platform) -> &'static [BrowserCandidate] {
    match platform {
        Platform::Macos => MAC_CANDIDATES,
        Platform::Windows => WINDOWS_CANDIDATES,
        Platform::Other => &[],
    }
}

/// Detects installed Chromium browsers without writing to browser profile directories.
pub fn detect_browsers(
    platform: Platform,
    home: Option<&Path>,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
) -> Vec<BrowserInstallation> {
    let base = match platform {
        Platform::Macos => home,
        Platform::Windows => local_app_data,
        Platform::Other => None,
    };
    candidates(platform)
        .iter()
        .filter_map(|candidate| {
            let profile = base.map(|path| path.join(candidate.profile_suffix));
            let executable = match platform {
                Platform::Macos => home.and_then(|path| {
                    candidate
                        .executable_suffixes
                        .iter()
                        .map(|suffix| path.join(suffix))
                        .find(|path| path.is_file())
                }),
                Platform::Windows => {
                    let roots = [local_app_data, program_files].into_iter().flatten();
                    roots
                        .flat_map(|root| {
                            candidate
                                .executable_suffixes
                                .iter()
                                .map(move |s| root.join(s))
                        })
                        .find(|path| path.is_file())
                }
                Platform::Other => None,
            };
            let profile = profile.filter(|path| path.is_dir());
            if executable.is_some() || profile.is_some() {
                Some(BrowserInstallation {
                    browser: candidate.browser,
                    executable,
                    profile_directory: profile,
                })
            } else {
                None
            }
        })
        .collect()
}

pub fn platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::Macos
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Other
    }
}

pub fn default_install_directory() -> PathBuf {
    if let Ok(override_path) = std::env::var("PERSPECTICA_INSTALL_DIR") {
        if !override_path.trim().is_empty() {
            return PathBuf::from(override_path);
        }
    }
    match platform() {
        Platform::Macos => std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Application Support/Perspectica/extension"),
        Platform::Windows => std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Perspectica/extension"),
        Platform::Other => std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".local/share/Perspectica/extension"),
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

pub fn verify_checksum(bytes: &[u8], expected: &str) -> Result<()> {
    let expected = expected.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(InstallerError::ChecksumManifest(
            "expected a 64-character SHA-256 digest".to_string(),
        ));
    }
    let actual = sha256_hex(bytes);
    if actual != expected {
        return Err(InstallerError::Checksum { expected, actual });
    }
    Ok(())
}

/// Finds an asset digest in a `SHA256SUMS`-style file. A filename, when present,
/// must match the requested asset, preventing a checksum for another artifact
/// from being applied accidentally.
pub fn checksum_for_asset(manifest: &str, asset_name: &str) -> Result<String> {
    let mut unscoped: Option<String> = None;
    for line in manifest.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let digest = fields.next().unwrap_or_default().to_ascii_lowercase();
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let filename = fields.next().map(|name| name.trim_start_matches('*'));
        match filename {
            Some(name)
                if name == asset_name
                    || Path::new(name).file_name().and_then(|x| x.to_str()) == Some(asset_name) =>
            {
                return Ok(digest);
            }
            Some(_) => continue,
            None => unscoped = Some(digest),
        }
    }
    unscoped.ok_or_else(|| {
        InstallerError::ChecksumManifest(format!("no SHA-256 entry for {asset_name}"))
    })
}

pub fn validate_zip_entries(bytes: &[u8]) -> Result<()> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| InstallerError::Archive(error.to_string()))?;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| InstallerError::Archive(error.to_string()))?;
        let name = entry.name();
        if name.starts_with('/')
            || name.starts_with('\\')
            || name.as_bytes().get(1).is_some_and(|byte| *byte == b':')
            || name.split(['/', '\\']).any(|part| part == "..")
        {
            return Err(InstallerError::Archive(format!(
                "unsafe path in archive: {name}"
            )));
        }
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| InstallerError::Archive(format!("unsafe path in archive: {name}")))?;
        if enclosed.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(InstallerError::Archive(format!(
                "unsafe path in archive: {name}"
            )));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(InstallerError::Archive(format!(
                "symbolic links are not allowed in archive: {name}"
            )));
        }
    }
    Ok(())
}

fn extract_to_directory(bytes: &[u8], destination: &Path) -> Result<()> {
    validate_zip_entries(bytes)?;
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| InstallerError::Archive(error.to_string()))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| InstallerError::Archive(error.to_string()))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| InstallerError::Archive(format!("unsafe path: {}", entry.name())))?
            .to_path_buf();
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(&output)?;
        io::copy(&mut entry, &mut file)?;
    }
    Ok(())
}

pub fn read_marker(destination: &Path) -> Result<InstallMarker> {
    let bytes = fs::read(destination.join(MARKER_FILE))?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn install_verified_zip(
    bytes: &[u8],
    destination: &Path,
    version: &str,
    expected_sha256: &str,
    source: &str,
) -> Result<InstallMarker> {
    verify_checksum(bytes, expected_sha256)?;
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let staging = tempfile::Builder::new()
        .prefix("perspectica-install-")
        .tempdir_in(parent)?;
    extract_to_directory(bytes, staging.path())?;
    let marker = InstallMarker {
        schema_version: 1,
        version: version.to_string(),
        sha256: sha256_hex(bytes),
        source: source.to_string(),
        installed_at_unix_seconds: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    let marker_path = staging.path().join(MARKER_FILE);
    let mut marker_file = File::create(marker_path)?;
    serde_json::to_writer_pretty(&mut marker_file, &marker)?;
    marker_file.write_all(b"\n")?;
    let staging_path = staging.keep();
    let backup = parent.join(format!(
        ".perspectica-backup-{}-{}",
        std::process::id(),
        marker.installed_at_unix_seconds
    ));
    if backup.exists() {
        fs::remove_dir_all(&backup)?;
    }
    if destination.exists() {
        fs::rename(destination, &backup)?;
    }
    if let Err(error) = fs::rename(&staging_path, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        let _ = fs::remove_dir_all(&staging_path);
        return Err(error.into());
    }
    if backup.exists() {
        fs::remove_dir_all(backup)?;
    }
    Ok(marker)
}

pub fn update_marker(
    destination: &Path,
    version: &str,
    source: Option<&str>,
) -> Result<InstallMarker> {
    let mut marker = read_marker(destination)?;
    marker.version = version.to_string();
    if let Some(source) = source {
        marker.source = source.to_string();
    }
    let mut file = File::create(destination.join(MARKER_FILE))?;
    serde_json::to_writer_pretty(&mut file, &marker)?;
    file.write_all(b"\n")?;
    Ok(marker)
}

pub fn uninstall(destination: &Path) -> Result<()> {
    if !destination.exists() {
        return Ok(());
    }
    read_marker(destination).map_err(|error| match error {
        InstallerError::Io(_) => InstallerError::UninstallMarkerMissing,
        other => other,
    })?;
    fs::remove_dir_all(destination)?;
    Ok(())
}

pub fn download_release_asset(
    asset_url: &str,
    checksum_url: &str,
    asset_name: &str,
) -> Result<(Vec<u8>, String)> {
    for url in [asset_url, checksum_url] {
        if !url.starts_with("https://") {
            return Err(InstallerError::InsecureUrl(url.to_string()));
        }
    }
    let client = https_client()?;
    let asset = read_bounded_response(
        client.get(asset_url).send()?.error_for_status()?,
        MAX_RELEASE_BYTES,
    )?;
    let manifest_bytes = read_bounded_response(
        client.get(checksum_url).send()?.error_for_status()?,
        MAX_CHECKSUM_BYTES,
    )?;
    let manifest = String::from_utf8(manifest_bytes)
        .map_err(|error| InstallerError::ChecksumManifest(error.to_string()))?;
    let expected = checksum_for_asset(&manifest, asset_name)?;
    verify_checksum(&asset, &expected)?;
    Ok((asset, expected))
}

fn https_client() -> Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .user_agent("perspectica-installer/0.1")
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.url().scheme() == "https" && attempt.previous().len() <= 5 {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()?)
}

fn read_bounded_response(response: reqwest::blocking::Response, limit: u64) -> Result<Vec<u8>> {
    if response.url().scheme() != "https" {
        return Err(InstallerError::InsecureUrl(response.url().to_string()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err(InstallerError::ResponseTooLarge { limit });
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(InstallerError::Io)?;
    if bytes.len() as u64 > limit {
        return Err(InstallerError::ResponseTooLarge { limit });
    }
    Ok(bytes)
}

fn validate_repository(repository: &str) -> Result<()> {
    let mut pieces = repository.split('/');
    let valid_piece = |piece: &str| {
        !piece.is_empty()
            && piece.len() <= 100
            && piece
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    let owner = pieces.next().unwrap_or_default();
    let name = pieces.next().unwrap_or_default();
    if !valid_piece(owner) || !valid_piece(name) || pieces.next().is_some() {
        return Err(InstallerError::Repository(repository.to_string()));
    }
    Ok(())
}

/// Retrieves the newest non-draft GitHub release, locates its extension ZIP and
/// checksum manifest, then verifies the exact named checksum before returning.
pub fn download_latest_github_release(repository: &str) -> Result<DownloadedRelease> {
    validate_repository(repository)?;
    let api_url = format!("https://api.github.com/repos/{repository}/releases/latest");
    let client = https_client()?;
    let metadata = read_bounded_response(
        client
            .get(api_url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()?
            .error_for_status()?,
        MAX_CHECKSUM_BYTES,
    )?;
    let release: GitHubRelease = serde_json::from_slice(&metadata)?;
    let expected_name = format!("perspectica-extension-{}.zip", release.tag_name);
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == expected_name)
        .or_else(|| {
            release.assets.iter().find(|asset| {
                asset.name.starts_with("perspectica-extension-") && asset.name.ends_with(".zip")
            })
        })
        .ok_or_else(|| {
            InstallerError::ReleaseMetadata("extension ZIP asset is missing".to_string())
        })?;
    let checksums = release
        .assets
        .iter()
        .find(|asset| asset.name == "SHA256SUMS")
        .ok_or_else(|| {
            InstallerError::ReleaseMetadata("SHA256SUMS asset is missing".to_string())
        })?;
    let (bytes, sha256) = download_release_asset(
        &asset.browser_download_url,
        &checksums.browser_download_url,
        &asset.name,
    )?;
    Ok(DownloadedRelease {
        version: release.tag_name,
        asset_name: asset.name.clone(),
        source_url: asset.browser_download_url.clone(),
        sha256,
        bytes,
    })
}

fn scheduler_binary_path() -> Result<PathBuf> {
    let root = default_install_directory()
        .parent()
        .map(Path::to_path_buf)
        .ok_or(InstallerError::UnsupportedPlatform)?;
    Ok(root.join("bin").join(if cfg!(target_os = "windows") {
        "perspectica-installer.exe"
    } else {
        "perspectica-installer"
    }))
}

fn copy_scheduler_binary() -> Result<PathBuf> {
    let source = std::env::current_exe()?;
    let target = scheduler_binary_path()?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if source != target {
        fs::copy(source, &target)?;
    }
    Ok(target)
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Installs an explicit, nonresident developer-channel update task. The copied
/// helper checks the latest GitHub release at login and once daily. It never
/// modifies browser policy or reloads the browser extension silently.
pub fn configure_update_schedule(repository: &str) -> Result<PathBuf> {
    validate_repository(repository)?;
    let binary = copy_scheduler_binary()?;
    match platform() {
        Platform::Macos => {
            let home = std::env::var_os("HOME")
                .map(PathBuf::from)
                .ok_or(InstallerError::UnsupportedPlatform)?;
            let agents = home.join("Library/LaunchAgents");
            fs::create_dir_all(&agents)?;
            let plist = agents.join("com.perspectica.developer-updater.plist");
            let content = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>com.perspectica.developer-updater</string>\n<key>ProgramArguments</key><array><string>{}</string><string>update-latest</string><string>--repository</string><string>{}</string></array>\n<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>86400</integer>\n</dict></plist>\n",
                xml_escape(&binary.to_string_lossy()),
                xml_escape(repository)
            );
            fs::write(&plist, content)?;
            Ok(plist)
        }
        Platform::Windows => {
            let action = format!(
                "\"{}\" update-latest --repository {}",
                binary.display(),
                repository
            );
            for (name, schedule) in [
                ("Perspectica Developer Update Daily", "DAILY"),
                ("Perspectica Developer Update Logon", "ONLOGON"),
            ] {
                let mut command = Command::new("schtasks.exe");
                command.args([
                    "/Create", "/F", "/SC", schedule, "/TN", name, "/TR", &action,
                ]);
                if schedule == "DAILY" {
                    command.args(["/ST", "09:00"]);
                }
                let status = command.status()?;
                if !status.success() {
                    return Err(InstallerError::Scheduler(format!(
                        "schtasks failed for {name}"
                    )));
                }
            }
            Ok(binary)
        }
        Platform::Other => Err(InstallerError::UnsupportedPlatform),
    }
}

pub fn remove_update_schedule() -> Result<()> {
    match platform() {
        Platform::Macos => {
            if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
                let plist = home
                    .join("Library/LaunchAgents")
                    .join("com.perspectica.developer-updater.plist");
                if plist.exists() {
                    fs::remove_file(plist)?;
                }
            }
        }
        Platform::Windows => {
            for name in [
                "Perspectica Developer Update Daily",
                "Perspectica Developer Update Logon",
            ] {
                let _ = Command::new("schtasks.exe")
                    .args(["/Delete", "/F", "/TN", name])
                    .status();
            }
        }
        Platform::Other => return Err(InstallerError::UnsupportedPlatform),
    }
    if let Ok(binary) = scheduler_binary_path() {
        if binary.exists() && std::env::current_exe().ok().as_ref() != Some(&binary) {
            fs::remove_file(binary)?;
        }
    }
    Ok(())
}

/// Opens the selected browser's extensions page and reveals the fixed unpacked
/// directory. The user still enables Developer mode and selects Load unpacked.
pub fn open_install_guidance(destination: &Path, installation: &BrowserInstallation) -> Result<()> {
    let executable = installation.executable.as_ref().ok_or_else(|| {
        InstallerError::Launch(format!(
            "{} executable was not detected",
            installation.browser.label()
        ))
    })?;
    Command::new(executable)
        .arg(installation.browser.extensions_url())
        .spawn()
        .map_err(|error| InstallerError::Launch(error.to_string()))?;

    let reveal_result = match platform() {
        Platform::Macos => Command::new("open").arg("-R").arg(destination).spawn(),
        Platform::Windows => Command::new("explorer.exe")
            .arg(format!("/select,{}", destination.display()))
            .spawn(),
        Platform::Other => Command::new("xdg-open").arg(destination).spawn(),
    };
    reveal_result
        .map(|_| ())
        .map_err(|error| InstallerError::Launch(error.to_string()))
}

pub fn print_guidance(destination: &Path, detected: &[BrowserInstallation]) -> String {
    let browser_names = if detected.is_empty() {
        "Chrome, Edge, or Brave (not detected)".to_string()
    } else {
        detected
            .iter()
            .map(|browser| browser.browser.label())
            .collect::<Vec<_>>()
            .join(", ")
    };
    format!(
        "Detected: {browser_names}.\n\nTo load Perspectica, open the browser's extensions page, enable Developer mode, choose Load unpacked, and select:\n{}\n\nThis helper only guides a visible Load unpacked action. It never installs through enterprise policy, registry/profile mutation, or a silent install.",
        destination.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(&mut output);
        for (name, body) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap();
        output.into_inner()
    }

    #[test]
    fn verifies_checksum_and_parses_named_manifest_entry() {
        let bytes = b"hello release";
        let digest = sha256_hex(bytes);
        let manifest = format!("{digest} *perspectica.zip\n");
        assert_eq!(
            checksum_for_asset(&manifest, "perspectica.zip").unwrap(),
            digest
        );
        verify_checksum(bytes, &digest).unwrap();
        assert!(verify_checksum(bytes, &"0".repeat(64)).is_err());
    }

    #[test]
    fn rejects_zip_slip_and_accepts_nested_files() {
        let safe = zip_bytes(&[("dist/manifest.json", b"{}")]);
        validate_zip_entries(&safe).unwrap();
        let unsafe_zip = zip_bytes(&[("../../outside.txt", b"nope")]);
        assert!(validate_zip_entries(&unsafe_zip).is_err());
    }

    #[test]
    fn installs_marker_and_uninstalls_only_marked_directory() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("extension");
        let bytes = zip_bytes(&[("manifest.json", b"{}")]);
        let digest = sha256_hex(&bytes);
        let marker = install_verified_zip(&bytes, &destination, "v1", &digest, "test").unwrap();
        assert_eq!(marker.version, "v1");
        assert!(destination.join("manifest.json").is_file());
        assert_eq!(read_marker(&destination).unwrap().sha256, digest);
        uninstall(&destination).unwrap();
        assert!(!destination.exists());
        let unknown = root.path().join("unknown");
        fs::create_dir_all(&unknown).unwrap();
        assert!(matches!(
            uninstall(&unknown),
            Err(InstallerError::UninstallMarkerMissing)
        ));
    }

    #[test]
    fn detects_mac_browsers_from_profile_or_executable() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        fs::create_dir_all(home.join("Library/Application Support/Google/Chrome/Default")).unwrap();
        assert_eq!(
            detect_browsers(Platform::Macos, Some(home), None, None)[0].browser,
            Browser::Chrome
        );
    }

    #[test]
    fn detects_windows_browsers_from_local_app_data() {
        let root = tempfile::tempdir().unwrap();
        let local_app_data = root.path();
        fs::create_dir_all(local_app_data.join("Microsoft/Edge/User Data/Default")).unwrap();
        let detected = detect_browsers(Platform::Windows, None, Some(local_app_data), None);
        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].browser, Browser::Edge);
    }

    #[test]
    fn guidance_never_promises_silent_install() {
        let text = print_guidance(Path::new("/tmp/perspectica"), &[]);
        assert!(text.contains("Load unpacked"));
        assert!(text.contains("never installs through enterprise policy"));
    }

    #[test]
    fn uses_browser_specific_extensions_pages() {
        assert_eq!(Browser::Chrome.extensions_url(), "chrome://extensions");
        assert_eq!(Browser::Edge.extensions_url(), "edge://extensions");
        assert_eq!(Browser::Brave.extensions_url(), "brave://extensions");
    }
}
