"""`python -m piper.train` with two checkpoint changes (same arguments: fit --data... --model...).

piper-tts 1.8.0 always adds ModelCheckpoint(monitor="val_mos"). With the MOS predictor off
(--model.mos_metric none, or when it cannot be downloaded), val_mos is never logged and Lightning
stops the whole training at the end of the first epoch (MisconfigurationException: could not find
the monitored key). Seen in a local dry run. That checkpoint goes.

It also keeps the 5 best checkpoints by val_mel beside last.ckpt, ~880 MB each. Only last.ckpt is
exported, and with two voices training at once the other ones would fill ~9 GB: keep the best one.
"""
import piper.train.__main__ as piper_train

piper_train._DEFAULT_CALLBACKS[:] = [
    cb for cb in piper_train._DEFAULT_CALLBACKS if getattr(cb, 'monitor', None) != 'val_mos'
]
for cb in piper_train._DEFAULT_CALLBACKS:
    cb.save_top_k = 1

if __name__ == '__main__':
    piper_train.main()
