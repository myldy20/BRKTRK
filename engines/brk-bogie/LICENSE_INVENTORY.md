# BRK BOGIE license inventory

BRKTRK is GPL-3.0-only. The BRK Bogie performer, ABI adapter and metadata
are Myldy design / Ilya Tolstoukhov contributions distributed as part of
that GPL-3.0-only project. See the root `LICENSE`.

The vendored Bogie DSP core and standalone test originate from Choo Choo
Rack by Pierre-Emmanuel Surga, commit `8986ceff930044780d259128990c142595ecd87d`,
and retain their MIT license in `third_party/choochoorack/LICENSE`. The DSP
source and header are byte-identical to that revision. The upstream test
changes only its include path for the vendored layout.

The source was migrated from BRKSNTH_private main
`70d7244895591d1db6c25afaead7009353a0e4bb`; the original preview binary is not
republished. A new package requires its own build and host verification.
