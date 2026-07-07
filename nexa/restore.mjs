#!/usr/bin/env node
// nexa/restore.mjs — return the working tree to the pristine base (undo an apply).
import { restore } from "./lib/overlay.mjs";
restore();
