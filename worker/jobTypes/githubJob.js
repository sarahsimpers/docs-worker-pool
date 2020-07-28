const fs = require('fs-extra');
const workerUtils = require('../utils/utils');
const simpleGit = require('simple-git/promise');
const request = require('request');


class GitHubJobClass {
    // pass in a job payload to setup class
    constructor(currentJob) {
        this.currentJob = currentJob;
    }

    // get base path for public/private repos
    getBasePath() {
        const currentJob = this.currentJob;
        var basePath = (currentJob.payload.private) ? `https://${process.env.GITHUB_BOT_USERNAME}:${process.env.GITHUB_BOT_PASSWORD}@github.com`:"https://github.com";
        return basePath;
    }

    getRepoDirName() {
        return `${this.currentJob.payload.repoName}`;
    }

    buildNextGen() {
        const workerPath = `repos/${this.getRepoDirName()}/worker.sh`;
        if (fs.existsSync(workerPath)) {
            // the way we now build is to search for a specific function string in worker.sh
            // which then maps to a specific target that we run
            const workerContents = fs.readFileSync(workerPath, {
                encoding: 'utf8'
            });
            const workerLines = workerContents.split(/\r?\n/);

            // check if need to build next-gen instead
            for (let i = 0; i < workerLines.length; i++) {
                if (workerLines[i] === '"build-and-stage-next-gen"') {
                    return true;
                }
            }
        }
        return false;
    }
    async writeEnvProdFile(isProdDeployJob){
      var pathPrefix;
      console.log(this.currentJob.payload.repoName)
      if(isProdDeployJob){
        //download published branches file to check if repo is versioned 
        console.log("this is a prod job what??")
        const repoObject = {
          repoOwner: this.currentJob.payload.repoOwner, repoName: this.currentJob.payload.repoName,
        };
        const repoContent = workerUtils.getRepoPublishedBranches(repoObject)
        //versioned repo
        if(repoContent && repoContent.content.version.active.length() > 1){
          pathPrefix = `${this.currentJob.payload.repoName.replace('docs-','')}/${this.currentJob.payload.branchName}` 
        }
        //non-versioned repo
        else{
          pathPrefix = `${this.currentJob.payload.repoName.replace('docs-','')}`
        }
      }
      // server staging commit jobs
      else if(this.currentJob.payload.patch && this.currentJob.payload.patchType === 'commit'){
        console.log(`${this.currentJob.payload.repoName.replace('docs-','')}`)
        console.log(`${this.currentJob.payload.repoName.replace('docs-','')}/${this.currentJob.user}/${this.currentJob.payload.localBranchName}`)
        pathPrefix = `${this.currentJob.payload.repoName.replace('docs-','')}/${this.currentJob.user}/${this.currentJob.payload.localBranchName}` 
      }
      // regular staging jobs via githubPush && commitless server staging jobs
      else{
        console.log(this.currentJob.payload.patchType, this.currentJob.payload.patchType === 'commit')
        pathPrefix = `${this.currentJob.payload.repoName.replace('docs-','')}/${this.currentJob.branchName}` 
      }
      console.log(pathPrefix)
      const envVars = `
      GATSBY_PARSER_USER=${this.currentJob.user}; 
      GATSBY_PARSER_BRANCH=${this.currentJob.patch ? this.currentJob.payload.localbranch : this.currentJob.payload.branchName};  
      COMMIT_HASH="${this.currentJob.payload.newHead}";
      PATH_PREFIX=${pathPrefix}`

      fs.writeFile(`repos/${this.getRepoDirName()}/.env.production`, envVars,  { encoding: 'utf8', flag: 'w' }, function(err) {
          if(err) {
              return console.log(err);
          }
      }); 
    }

    async applyPatch(patch, currentJobDir) {
        //create patch file
        try {
          await fs.writeFileSync(`repos/${currentJobDir}/myPatch.patch`, patch, { encoding: 'utf8', flag: 'w' });
          
        } catch (error) {
            console.log("Error creating patch ", error);
            throw error;
        }
        //apply patch
        try {
          const commandsToBuild = [
            `cd repos/${currentJobDir}`,
            `patch -p1 < myPatch.patch`
          ];
            const exec = workerUtils.getExecPromise();
          // return new Promise((resolve, reject) => {
            await exec(commandsToBuild.join(" && "));
    
        } catch (error) {
            console.log("Error applying patch: ", error);
            throw error;
        }
    }

    dumpError(err) {
        if (typeof err === 'object') {
          if (err.message) {
            console.log('\nMessage: ' + err.message)
          }
          if (err.stack) {
            console.log('\nStacktrace:')
            console.log('====================')
            console.log(err.stack);
          }
        } else {
          console.log('dumpError :: argument is not an object');
        }
    }

    // our maintained directory of makefiles
    async downloadMakefile() {
        const makefileLocation = `https://raw.githubusercontent.com/madelinezec/docs-worker-pool/meta-DOP-1238/makefiles/Makefile.${this.currentJob.payload.repoName}`;
        const returnObject = {};
        return new Promise(function(resolve, reject) {
            request(makefileLocation, function(error, response, body) {
                if (!error && body && response.statusCode === 200) {
                    returnObject['status'] = 'success';
                    returnObject['content'] = body;
                } else {
                    returnObject['status'] = 'failure';
                    returnObject['content'] = response;
                }
                resolve(returnObject);
                reject(error);
            });
        });
    }

    // cleanup before pulling repo
    async cleanup(logger) {
        logger.save(`${'(rm)'.padEnd(15)}Cleaning up repository`);
        try {
            workerUtils.removeDirectory(`repos/${this.getRepoDirName()}`);
        } catch (errResult) {
            logger.save(`${'(CLEANUP)'.padEnd(15)}failed cleaning repo directory`);
            throw errResult;
        }
        return new Promise(function(resolve, reject) {
            logger.save(`${'(rm)'.padEnd(15)}Finished cleaning repo`);
            resolve(true);
            reject(false);
        });
    }

    async cloneRepo(logger) {
        const currentJob = this.currentJob;
        logger.save(`${'(GIT)'.padEnd(15)}Cloning repository`);
        logger.save(`${'(GIT)'.padEnd(15)}running fetch`);
        try {
            if (!currentJob.payload.branchName) {
                logger.save(
                    `${'(CLONE)'.padEnd(15)}failed due to insufficient definition`
                );
                throw new Error('branch name not indicated');
            }
            const basePath = this.getBasePath();
            const repoPath =
                basePath +
                '/' +
                currentJob.payload.repoOwner +
                '/' +
                currentJob.payload.repoName;
            await simpleGit('repos')
                .silent(false)
                .clone(repoPath, `${this.getRepoDirName()}`)
                .catch(err => {
                    console.error('failed: ', err);
                    throw err;
                });
        } catch (errResult) {
            logger.save(`${'(GIT)'.padEnd(15)}stdErr: ${errResult.stderr}`);
            throw errResult;
        }
        return new Promise(function(resolve, reject) {
            logger.save(`${'(GIT)'.padEnd(15)}Finished git clone`);
            resolve(true);
            reject(false);
        });
    }

    async buildRepo(logger, isProdDeployJob) {
        const currentJob = this.currentJob;

        // setup for building
        await this.cleanup(logger);
        await this.cloneRepo(logger);

        logger.save(`${'(BUILD)'.padEnd(15)}Running Build`);
        logger.save(`${'(BUILD)'.padEnd(15)}running worker.sh`);


        const exec = workerUtils.getExecPromise();
        const pullRepoCommands = [`cd repos/${this.getRepoDirName()}`];

        // if commit hash is provided, use that
        if (currentJob.payload.newHead && currentJob.title !== 'Regression Test Child Process') {
            const commitCheckCommands = [
                `cd repos/${this.getRepoDirName()}`,
                `git fetch`,
                `git checkout ${currentJob.payload.branchName}`,
                `git branch ${currentJob.payload.branchName} --contains ${currentJob.payload.newHead}`
            ];

            try {
                const {
                    stdout
                } = await exec(commitCheckCommands.join('&&'));

                if (!stdout.includes(`* ${currentJob.payload.branchName}`)) {
                    const err = new Error(
                        `Specified commit does not exist on ${currentJob.payload.branchName} branch`
                    );
                    logger.save(
                        `${'(BUILD)'.padEnd(
              15
            )} failed. The specified commit does not exist on ${
              currentJob.payload.branchName
            } branch.`
                    );
                    return new Promise(function(resolve, reject) {
                        reject(err);
                    });
                }
            } catch (error) {
                logger.save(
                    `${'(BUILD)'.padEnd(15)}failed with code: ${error.code}. `
                );
                logger.save(`${'(BUILD)'.padEnd(15)}stdErr: ${error.stderr}`);
                throw error;
            }

            pullRepoCommands.push(
                ...[
                    `git checkout ${currentJob.payload.branchName}`,
                    `git pull origin ${currentJob.payload.branchName}`,
                    `git checkout ${currentJob.payload.newHead} .`
                ]
            );

        } else {
            pullRepoCommands.push(
                ...[
                    `git checkout ${currentJob.payload.branchName}`,
                    `git pull origin ${currentJob.payload.branchName}`
                ]
            );
        }

        try {
        
            await exec(pullRepoCommands.join(' && '));

        } catch (error) {
            logger.save(
                `${'(BUILD)'.padEnd(15)}failed with code: ${error.code}`
            );
            logger.save(`${'(BUILD)'.padEnd(15)}stdErr: ${error.stderr}`);

            throw error;
        }

              //check for patch
      if (currentJob.payload.patch !== undefined) {
        await this.applyPatch(
          currentJob.payload.patch,
          this.getRepoDirName(currentJob)
        );
      }

        // overwrite repo makefile with the one our team maintains
        const makefileContents = await this.downloadMakefile();
        if (makefileContents && makefileContents.status === 'success') {
            await fs.writeFileSync(
                `repos/${this.getRepoDirName()}/Makefile`,
                makefileContents.content, {
                    encoding: 'utf8',
                    flag: 'w'
                }
            );
        } else {
            console.log(
                'ERROR: makefile does not exist in /makefiles directory on meta branch.'
            );
        }
        //set up env vars 
        await this.writeEnvProdFile(isProdDeployJob)
        // default commands to run to build repo
        const commandsToBuild = [
          `. /venv/bin/activate`,
          `cd repos/${this.getRepoDirName()}`,
          `rm -f makefile`,
          `make html`
      ];

      // check if need to build next-gen
      if (this.buildNextGen() && !isProdDeployJob) {
        commandsToBuild[commandsToBuild.length - 1] = 'make next-gen-html';
      }

      //check if prod deploy job
      if (isProdDeployJob) {
          commandsToBuild[commandsToBuild.length - 1] = 'make download-published-branches';
          commandsToBuild.concat([`make next-gen-html publish`, `make configure-mut-redirects:`])
      }
      // we only deploy next gen right???

        const execTwo = workerUtils.getExecPromise();
        try {
            const {
                stdout,
                stderr
            } = await execTwo(commandsToBuild.join(' && '));
            print(stdout)
            print(stderr)
            return new Promise(function(resolve, reject) {
                logger.save(`${'(BUILD)'.padEnd(15)}Finished Build`);
                logger.save(
                    `${'(BUILD)'.padEnd(
                15
              )}worker.sh run details:\n\n${stdout}\n---\n${stderr}`
                );
                resolve({
                    status: 'success',
                    stdout: stdout,
                    stderr: stderr
                });
                reject({
                    status: 'success',
                    stderr: stderr
                });
            });
        } catch (error) {
          logger.save(
            `${'(BUILD)'.padEnd(15)}failed with code: ${error.code}`
          );
          logger.save(`${'(BUILD)'.padEnd(15)}stdErr: ${error.stderr}`);
          logger.save(`${'(BUILD)'.padEnd(15)}stdout: ${error.stdout}`);
          throw error;              
        }

    }
}

module.exports = {
    GitHubJobClass: GitHubJobClass
};
