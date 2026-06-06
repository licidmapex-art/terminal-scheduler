interface UnsavedChangesDialogProps {
  open: boolean;
  message: string;
  onSaveAndClose: () => void;
  onCloseWithoutSaving: () => void;
  onCancel: () => void;
}

export default function UnsavedChangesDialog({
  open,
  message,
  onSaveAndClose,
  onCloseWithoutSaving,
  onCancel
}: UnsavedChangesDialogProps) {
  if (!open) return null;

  return (
    <div className="modal-overlay" role="presentation" onClick={onCancel}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-changes-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="unsaved-changes-title" className="modal-title">
          Unsaved changes
        </h2>
        <p className="modal-message">{message}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onSaveAndClose}>
            Save and close
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCloseWithoutSaving}>
            Close without saving
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
