# CHARMM instructions

Before building docker image, you need to manually copy a CHARMM source tar.gz file here.

- Head over to the [CHARMM website](https://academiccharmm.org/)
- Register
- They will send you an email with download instructions.
  The latest version is **c49b1**
- Copy the `c49b1.tar.gz` file into this directory.
- Set the ENV variable for docker `CHARMM_VER=c49b1` in the appropriate `.env` file.
