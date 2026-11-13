import { Modal } from "../components/Modal";
import type { FormatUpgrade } from "../ipc/types";

interface Props {
  path: string;
  upgrade: FormatUpgrade;
  onUpgrade: () => void;
  /** Offered where the file isn't open read-only already. */
  onReadOnly?: (() => void) | undefined;
  onCancel: () => void;
}

/**
 * Asked before an open for editing raises a file's format: older trunkdb
 * releases can't open it afterwards, and nothing turns it back. Cancel
 * has the initial focus.
 */
export function FormatUpgradeDialog({ path, upgrade, onUpgrade, onReadOnly, onCancel }: Props) {
  const name = path.split(/[\\/]/).pop() ?? path;
  const writer = upgrade.written_by;
  return (
    <Modal title="Upgrade the file format?" onCancel={onCancel}>
      <div className="modal-body">
        <p>
          <strong>{name}</strong> has file format {upgrade.format_version}
          {writer !== null && <>, last written by trunkdb {writer}</>}. Opening it for editing
          changes it to format {upgrade.becomes}, the format of the bundled trunkdb{" "}
          {upgrade.bundled_release}.
        </p>
        <p>
          Programs that use an older trunkdb
          {writer !== null && <>, such as {writer},</>} can&apos;t open the file afterwards, and it
          can&apos;t be changed back to format {upgrade.format_version}.
        </p>
        {onReadOnly !== undefined && <p>Opened read-only, the file stays as it is.</p>}
      </div>
      <div className="modal-actions">
        <button type="button" onClick={onCancel} autoFocus>
          Cancel
        </button>
        {onReadOnly !== undefined && (
          <button type="button" onClick={onReadOnly}>
            Open read-only
          </button>
        )}
        <button type="button" className="danger" onClick={onUpgrade}>
          Upgrade and open
        </button>
      </div>
    </Modal>
  );
}
