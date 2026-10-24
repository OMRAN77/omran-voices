"""`python -m piper.train` without its "val_mos" checkpoint (same arguments: fit --data... --model...).

piper-tts 1.8.0 always adds ModelCheckpoint(monitor="val_mos"). With the MOS predictor off
(--model.mos_metric none, or when it cannot be downloaded), val_mos is never logged and Lightning
stops the whole training at the end of the first epoch (MisconfigurationException: could not find
the monitored key). Seen in a local dry run. The val_mel and last.ckpt checkpoints stay.
"""
import piper.train.__main__ as piper_train

piper_train._DEFAULT_CALLBACKS[:] = [
    cb for cb in piper_train._DEFAULT_CALLBACKS if getattr(cb, 'monitor', None) != 'val_mos'
]

if __name__ == '__main__':
    piper_train.main()
