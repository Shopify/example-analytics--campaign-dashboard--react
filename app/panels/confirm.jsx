// A destructive or one-way action asks once before it posts.
export function ConfirmButton({
  id,
  label,
  heading,
  body,
  confirmLabel,
  tone,
  variant,
  loading,
  disabled,
  onConfirm,
}) {
  return (
    <>
      <s-button
        tone={tone}
        variant={variant}
        loading={loading}
        disabled={disabled}
        commandFor={id}
        command="--show"
      >
        {label}
      </s-button>
      <s-modal id={id} heading={heading}>
        <s-paragraph>{body}</s-paragraph>
        <s-button slot="secondary-actions" commandFor={id} command="--hide">
          Go back
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          tone={tone}
          commandFor={id}
          command="--hide"
          onClick={onConfirm}
        >
          {confirmLabel}
        </s-button>
      </s-modal>
    </>
  );
}
