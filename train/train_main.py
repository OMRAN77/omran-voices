"""`python -m piper.train` with its own checkpointing (same arguments: fit --data... --model...).

piper-tts 1.8.0 keeps the best checkpoints by val_mel and by val_mos, and last.ckpt. Two things went
wrong with that:

- With the MOS predictor off (--model.mos_metric none, or when it cannot be downloaded), val_mos is
  never logged and Lightning stops the whole training at the end of the first epoch
  (MisconfigurationException: could not find the monitored key). Seen in a local dry run.
- Lightning 2.6 writes last.ckpt only in a step where a "best" checkpoint was written. val_mel stops
  improving early in a fine-tune (mel L1 saturates long before the adversarial losses have cleaned
  the sound), so last.ckpt stayed at an early epoch and that early model is what got exported. The
  first real voice (21 Nov) was heard as «صوت هواء ومش واضح»; its last upload said "No files have been
  modified": the checkpoint had not moved in the final half hour of training.

So Piper's checkpoint callbacks go, Lightning's own default one is turned off, and KeepLatest writes
last.ckpt every few epochs and when training ends, whatever the validation numbers say. One file of
~880 MB instead of six.
"""
import os
import sys
from pathlib import Path

from lightning.pytorch.callbacks import Callback

SAVE_EVERY_EPOCHS = 4  # an epoch of 250 clips is ~25 s on a T4; a save is ~880 MB


class KeepLatest(Callback):
    """last.ckpt = the model as it is now. Written under another name and renamed, so whoever copies
    last.ckpt while training runs (the notebook exports samples every half hour) never gets half a file."""

    def __init__(self, every_n_epochs=SAVE_EVERY_EPOCHS):
        self.every = max(1, int(every_n_epochs))

    def _save(self, trainer):
        if trainer.sanity_checking or not trainer.is_global_zero:
            return
        folder = Path(trainer.log_dir or trainer.default_root_dir) / 'checkpoints'
        folder.mkdir(parents=True, exist_ok=True)
        tmp = folder / 'last.ckpt.tmp'
        trainer.save_checkpoint(tmp)
        os.replace(tmp, folder / 'last.ckpt')

    def on_train_epoch_end(self, trainer, pl_module):
        if (trainer.current_epoch + 1) % self.every == 0:
            self._save(trainer)

    def on_train_end(self, trainer, pl_module):
        self._save(trainer)


def main():
    import piper.train.__main__ as piper_train

    piper_train._DEFAULT_CALLBACKS[:] = [KeepLatest()]
    if not any(a.startswith('--trainer.enable_checkpointing') for a in sys.argv):
        sys.argv += ['--trainer.enable_checkpointing', 'false']
    piper_train.main()


if __name__ == '__main__':
    main()
