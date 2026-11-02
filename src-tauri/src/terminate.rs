//! Quitting from outside the app on macOS: the Dock menu, AppleScript,
//! logout and shutdown send the application a terminate request. tao, under
//! Tauri, does not answer `applicationShouldTerminate:`, so AppKit would end
//! the app at once and an unsaved document draft would be lost.
//!
//! This adds the answer to tao's app delegate at startup. Without a
//! modified draft, it terminates now, as before: the normal exit path
//! releases the database. With one, it cancels, brings the window forward
//! and asks the frontend, exactly like Cmd+Q; the frontend then quits
//! through `app_quit`, which stops the event loop without another
//! terminate request. Cancelling also cancels a logout, which is how macOS
//! apps keep unsaved work.

use crate::state::AppState;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{class, msg_send, sel};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

/// `NSApplicationTerminateReply`.
const TERMINATE_CANCEL: usize = 0;
const TERMINATE_NOW: usize = 1;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Call once, on the main thread, after launch (from `setup`). If the
/// delegate cannot be found or already answers, nothing changes and a
/// quit from outside the app ends it without asking, as before.
pub fn install(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    // SAFETY: called on the main thread after launch; the method added has
    // the signature its type encoding states (NSUInteger, self, _cmd, id).
    let added = unsafe {
        let application: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![application, delegate];
        match delegate.as_ref() {
            Some(delegate) => {
                let imp = std::mem::transmute::<
                    extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
                    Imp,
                >(should_terminate);
                objc2::ffi::class_addMethod(
                    delegate.class() as *const AnyClass as *mut AnyClass,
                    sel!(applicationShouldTerminate:),
                    imp,
                    c"Q@:@".as_ptr(),
                )
                .as_bool()
            }
            None => false,
        }
    };
    if !added {
        eprintln!("TrunkDB Admin: quitting from the Dock cannot ask about unsaved changes");
    }
}

extern "C-unwind" fn should_terminate(_: &AnyObject, _: Sel, _: *mut AnyObject) -> usize {
    // Nothing may unwind into AppKit; when in doubt, let the quit happen.
    std::panic::catch_unwind(|| APP.get().map_or(TERMINATE_NOW, reply)).unwrap_or(TERMINATE_NOW)
}

fn reply(app: &AppHandle) -> usize {
    if !app.state::<AppState>().has_unsaved_draft() {
        return TERMINATE_NOW;
    }
    // The question needs to be seen, even when the app was hidden or the
    // window minimized.
    let _ = app.show();
    if let Some(window) = app.webview_windows().into_values().next() {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    if crate::menu::request_quit(app) {
        TERMINATE_CANCEL
    } else {
        TERMINATE_NOW
    }
}
