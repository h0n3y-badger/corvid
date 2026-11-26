//! Engine-independent host side of corvid: settings, themes/quick CSS,
//! privacy filtering and the injected mod bundle.

pub mod assets;
pub mod bundle;
pub mod host;
pub mod media;
pub mod paths;
pub mod privacy;
pub mod settings;
pub mod themes;
mod util;

pub use host::{Host, Ui};
pub use paths::Paths;
