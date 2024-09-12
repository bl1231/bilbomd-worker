"""
Module for the Genetic Algorithm for Ensemble Optimization
"""

import os
import time
from pathlib import Path
import numpy as np
import pandas as pd
import lmfit as lmf
import scipy.interpolate as scpint
import dask.distributed as distributed
from read_json_input import _read_json_input


def reduced_chi2(expected, model, sigma_exp, ddof=1):
    return (np.power((model - expected) / sigma_exp, 2)).sum() / (
        sigma_exp.shape[0] - ddof
    )


def unique_arr(arr):
    return np.unique(arr).shape[0] == arr.shape[0]


def probfitness_func(rchi2):
    """
    Alternative fitness function using squared values to properly select the fitness according to proximity to 1.0
    """
    if rchi2 < 1.0:
        fitness = 1 / np.power((1 / rchi2 - 1), 2)
    else:
        fitness = 1 / np.power((rchi2 - 1), 2)

    return fitness


def invert_x2(rchi2):
    return 1 / rchi2


def invert_absx2(rchi2):
    return 1 / abs(1 - rchi2)


def interpolate2exp(row, expQ):
    interp_Iq = scpint.splrep(row.index.values, row.values, s=0)
    # print(f'{expQ}')
    modI_expQ = scpint.splev(expQ, interp_Iq, der=0)
    return pd.Series(index=expQ, data=modI_expQ)


def _residual_lmf(pars, I, data=None, sigma=None):
    """
    Residual function for lmfit for the ensemble fits
    """
    parvals = pars.valuesdict()
    c = parvals["c"]
    b = parvals["b"]
    wkeys = list(parvals.keys())[2:]
    wparms = [parvals[ky] for ky in wkeys]
    I = I.reshape(-1, len(wkeys))
    # print(I[:,0].shape,data.shape)
    model = (
        c * (np.array([wparms[n] * I[:, n] for n in range(I.shape[1])]).sum(axis=0)) + b
    )

    # print(model.shape)
    if np.all(data) == None:
        return model
    if np.all(sigma) == None:
        return data - model
    else:
        return (data - model) / sigma


def gen_modelparams(ens_size, param_dict={}) -> None:
    """
    param_dict: for evaluating the model after the fitting with optimal parameters
    """
    pars = lmf.Parameters()
    if len(param_dict.keys()) == 0.0:
        pars.add_many(
            ("c", 4.0, True, 1e-12, np.inf), ("b", 1e-4, True, -np.inf, np.inf)
        )

        const_expr = "1.0"  ## constraint expression

        for nw in range(1, ens_size + 1, 1):
            pars.add(
                f"w{nw}", value=(1.0 / ens_size + 0.1), min=1e-12, max=1.0, vary=True
            )

            if nw == (ens_size):
                pars.add(f"w{nw}", min=1e-12, max=1.0, expr=const_expr, vary=False)
                break
            const_expr += f"-w{nw}"
    else:
        pars = lmf.Parameters()
        for ky in param_dict.keys():
            pars.add(ky, value=param_dict[ky])

    return pars


def fitness(set_data, expdata, ens_size, fitting_algorithm="Differential Evolution"):
    """
    Perform the fit to the experimental data
    Save the fit parameters and the chi2
    """
    fit_time_start = time.time()

    mpars = gen_modelparams(ens_size)
    ## check if self.experiment has error values:
    if "Error" in expdata.columns:
        sigmaI = expdata["Error"].values
    else:
        sigmaI = None

    minimize_fit = lmf.minimize(
        _residual_lmf,
        mpars,
        method=fitting_algorithm,
        args=(set_data,),
        kws={"data": expdata.iloc[:, 1].values, "sigma": sigmaI},
    )

    ## X2 is not the fitness here, the weight in choose_parents is so should be adjusted accordingly
    ##
    # self.gen_fitness[self.curr_gen, data_index]  = minimize_fit.redchi
    result = {
        "success": minimize_fit.success,
        "nfev": minimize_fit.nfev,
        "eval_time": (time.time() - fit_time_start),
        "chi2": minimize_fit.redchi,
        "aic": minimize_fit.aic,
        "params": minimize_fit.params.valuesdict(),
    }

    return result


class GAEnsembleOpt:
    """
    Class for the genetic algorithm. It is initiaed with the calculated ensembe data and the experimental data to validate against.

    parallel: should really always be true and can be the default even on one core.
    method: how to choose and rank the fitness
    rank_prob: ranking probability
    elitism: keep the top ranking child every iteration and do not crossover

    """

    def __init__(
        self,
        data,
        exp_data,
        ensemble_size=2,
        number_generations=100,
        number_iterations=5,
        ensemble_split=0.85,
        crossover_probability=0.5,
        mutation_probability=0.15,
        cutoff_weight=1e-6,
        method="prob",
        rank_prob=0.8,
        fitness_function="inverse_absolute",
        fitting_algorithm="Differential Evolution",
        parallel=True,
        elitism=True,
    ):

        self.ens_size = ensemble_size
        self.n_gen = number_generations
        self.n_iter = number_iterations
        self.curr_gen = 0
        self.method = method
        self.rankprob = rank_prob
        self.fitting_algorithm = fitting_algorithm
        ## use the inverted x2 as the fitness with the absolute value of 1-X^2
        if fitness_function == "inverse_absolute":
            self.invabsx2 = True
        else:
            self.invabsx2 = False

        ## Definitions of the data to fit and
        self.data = data  ## data should be in (nq, nConf) dataframe
        self.experiment = exp_data.astype("float")  ## should be a dataframe
        self.indices = np.arange(0, data.shape[1], 1)
        self.interp_data = self.data.T.apply(
            interpolate2exp,
            axis=1,
            expQ=self.experiment["Q"].values,
        )  ## Will Return (nConf, nq) dataframe

        ## Eventually need to change if any of the general parameters are changed
        remainder = (data.shape[1] * ensemble_split) % self.ens_size
        if remainder != 0:
            self.n_ens = int(
                (int(data.shape[1] * ensemble_split) - remainder) / self.ens_size
            )
            self.pool_size = int(data.shape[1] * ensemble_split - remainder)
        else:
            self.n_ens = int(data.shape[1] * ensemble_split / self.ens_size)
            self.pool_size = int(data.shape[1] * ensemble_split)

        ## must be even to divide into parents
        if (self.n_ens % 2) == 1:
            self.n_ens -= 1
            self.pool_size -= self.ens_size

        # self.ens_indices = np.zeros((self.n_ens,self.ens_size))
        print(self.data.shape[1], self.pool_size)
        self.mut_indices = np.zeros((self.data.shape[1] - self.pool_size, 1))

        ## class attribute for the ensemble fitting
        self.cut_weight = cutoff_weight

        ## class attributes for the ga algorithm
        self.parents = np.zeros((self.n_ens, self.ens_size))  # set of indices ...
        self.parent_pairs = np.zeros((int(self.n_ens / 2), 2, self.ens_size))
        self.elitism = elitism
        self.elite_child = []  ## for elitism
        self.children = np.zeros((self.n_ens, self.ens_size))  # set of indices ...

        self.gen_fitness = np.zeros((self.n_gen, self.n_ens))
        self.gen_rchi2 = np.zeros((self.n_gen, self.n_ens))
        self.gen_aic = np.zeros((self.n_gen, self.n_ens))

        self.fitness_check = np.ones(
            (self.n_ens, self.n_gen)
        )  ## checks to see if the fit produces proper weights
        self.p_crossover = crossover_probability
        self.p_mutate = mutation_probability

        ##convergence criteria
        self.gen_converged = False
        self.iter_converged = False

        self.fitness_saturation = 0  ## count how many generations have the same minimum
        self.pbest_rchi2 = {
            "chi2": 0,
            "aic": 0,
            "fitness": 0,
            "ensemble": [0] * self.n_gen,
            "gen_found": 0,
            "fit_pars": {},
        }  ## previous best aic

        ## start at aic -np.inf ==> RelLikelihood=0, same with rchi2
        self.cbest_rchi2 = {
            "chi2": np.inf,
            "aic": np.inf,
            "fitness": 0,
            "ensemble": [0] * self.n_gen,
            "gen_found": 0,
            "fit_pars": {},
        }  ## current best aic
        self.citbest_rchi2 = self.pbest_rchi2
        self.itbest_rchi2 = [dict() for n in range(self.n_iter)]

        ## average time to calculate the , total time spent doing the fitness calculation,
        ## time spent evaluating, time for validation, time updating for parents, crossovers, mutation
        ## fitness total ~= evaluation time
        self.individual_fitness_time = np.zeros((self.n_ens, 1))
        self.time_log = {
            "fitness_ave": 0.0,
            "fitness_total": 0.0,
            "evaluation": 0.0,
            "validation": 0.0,
            "parents": 0.0,
            "crossover": 0.0,
            "mutation": 0.0,
        }

        ## Parallel Options
        ## Fraction of CPUs we want to use? Maybe better to use a localcluster outside of the

        self.parallel = parallel

    def randomcol_indices(self):
        """
        randomize the column selections from the data
        """
        return np.random.choice(
            np.arange(0, self.data.shape[1], 1), self.pool_size, replace=False
        ).reshape(-1, self.ens_size)

    def evaluate(self, client):
        """
        Fit each of the parents to the experimental data
        Evaluate the fitness from the fits

        For Loop can be parallelized with multiprocess?
        """
        eval_time_start = time.time()
        ensemble_scattering_parents = np.rollaxis(
            self.interp_data.values[self.parents, :], 2, 1
        )

        mfit_array = {}
        if self.parallel:
            # with distributed.LocalCluster(n_workers=self.cpus,
            #                  processes=True,
            #                  threads_per_worker=1,
            #                 ) as cluster, distributed.Client(cluster) as client:

            fitmap = client.map(
                fitness,
                ensemble_scattering_parents,
                expdata=self.experiment,
                ens_size=self.ens_size,
                fitting_algorithm=self.fitting_algorithm,
            )
            fitmap_seq = distributed.as_completed(fitmap)

            for nfit, fit in enumerate(fitmap_seq):
                mfit_array.update({nfit: fit.result()})
        else:
            for nfit, ens_data in enumerate(ensemble_scattering_parents):
                # print(datindex)
                mfit_array.update(self.fitness(ens_data, self.experiment))

        self.time_log["evaluation"] = time.time() - eval_time_start
        ##print(self.pars.valuesdict(), mfit_array[0]['params'])
        self.gen_paramfit = pd.DataFrame(
            index=list(mfit_array[0]["params"].keys()), columns=np.arange(0, self.n_ens)
        ).fillna(0.0)

        for data_index in list(mfit_array.keys()):
            self.gen_rchi2[self.curr_gen, data_index] = mfit_array[data_index]["chi2"]
            self.gen_aic[self.curr_gen, data_index] = mfit_array[data_index]["aic"]
            self.gen_paramfit.loc[list(mfit_array[0]["params"].keys()), data_index] = (
                list(mfit_array[data_index]["params"].values())
            )
            self.individual_fitness_time[data_index] = mfit_array[data_index][
                "eval_time"
            ]

        if self.method == "prob":
            if not self.invabsx2:  ## if invabsx2 is False, use the standard inversion
                x2weight = np.apply_along_axis(
                    invert_x2, 1, self.gen_rchi2[self.curr_gen, :].reshape(-1, 1)
                )
                self.gen_fitness[self.curr_gen, :] = x2weight.flatten()
            else:  ## else use the absolute value so the X^2 converges to 1 (may be helpful in data with high error)
                x2weight = np.apply_along_axis(
                    invert_absx2, 1, self.gen_rchi2[self.curr_gen, :].reshape(-1, 1)
                )
                self.gen_fitness[self.curr_gen, :] = x2weight.flatten()

        elif self.method == "rank":
            self.gen_fitness[self.curr_gen, :] = self.gen_rchi2[self.curr_gen, :]

        elif self.method == "prob_div":
            x2weight = np.apply_along_axis(
                invert_x2, 1, self.gen_rchi2[self.curr_gen, :].reshape(-1, 1)
            )
            self.gen_fitness[self.curr_gen, :] = x2weight.flatten()

        elif self.method == "rank_div":
            self.gen_fitness[self.curr_gen, :] = self.gen_rchi2[self.curr_gen, :]

        self.time_log["evaluation"] = time.time() - eval_time_start

    def validate_and_update(self):
        """
        validate the fits and choose the best, unique solutions to save?
        ## if the diversity methods are chosen, need to save the best solutions for propagation
        in which case
        """
        validate_time_start = time.time()

        valid_solutions = ~np.any(
            self.gen_paramfit.iloc[2:, :] < self.cut_weight, axis=0
        )
        unique_ensembles = np.apply_along_axis(unique_arr, 1, self.parents)

        vu_indices = np.where(valid_solutions & unique_ensembles)[0]
        vu_parents = self.parents[valid_solutions & unique_ensembles]

        vu_aic = self.gen_aic[self.curr_gen, valid_solutions & unique_ensembles]
        vu_chi2 = self.gen_rchi2[self.curr_gen, valid_solutions & unique_ensembles]
        vu_fitness = self.gen_fitness[self.curr_gen, valid_solutions & unique_ensembles]

        ## remove duplicate parents
        ### Check sizes to make sure their are valid solutions. If no valid solutions,
        ### race condition met and start a new iteration.
        unique_sol, unq_solut_ndx = np.unique(vu_parents, axis=0, return_index=True)
        if len(unq_solut_ndx) == 0.0:
            print(
                f"No valid solutions found given the bounds. This occured at iteration {self.curr_gen} and generation {self.curr_gen}."
            )
            print(f"Moving onto the next iteration")
            self.check_genconvergence = True
            return None

        else:
            self.unique_solutions = unique_sol
            self.n_valid_unique_solutions = self.unique_solutions.shape[0]

        ## Structure check?

        ##current best valid solutions
        # rel_rchi2 = selfself.cbest_rchi2
        fitmax_index = np.where(
            vu_fitness[unq_solut_ndx] == vu_fitness[unq_solut_ndx].max()
        )[0]
        vufitmax = unq_solut_ndx[fitmax_index]
        ##{ 'chi2':0,'fitness', 'ensemble':[0]*self.n_gen, 'gen_found':0, 'fit_pars':{}}

        if vu_fitness.max() > self.cbest_rchi2["fitness"]:

            print(
                f"Fitness updated from {self.cbest_rchi2['fitness']} to {vu_fitness[unq_solut_ndx].max()}"
            )

            self.pbest_rchi2 = self.cbest_rchi2
            # self.cbest_aic['aic'] = vu_aic[unq_solut_ndx].min()
            self.cbest_rchi2["chi2"] = vu_chi2[vufitmax]
            self.cbest_rchi2["aic"] = vu_aic[vufitmax]
            self.cbest_rchi2["fitness"] = vu_fitness[vufitmax]
            self.cbest_rchi2["ensemble"] = vu_parents[vufitmax]
            self.cbest_rchi2["gen_found"] = self.curr_gen
            # print(self.gen_paramfit.T[valid_solutions&unique_ensembles].iloc[vufitmax])
            self.cbest_rchi2["fit_pars"] = (
                self.gen_paramfit.T[valid_solutions & unique_ensembles]
                .iloc[vufitmax]
                .to_dict("list")
            )
            ## convert dict entries to floats not lists
            for key in list(self.cbest_rchi2["fit_pars"].keys()):
                self.cbest_rchi2["fit_pars"][key] = self.cbest_rchi2["fit_pars"][key][0]
            self.fitness_saturation = 0

        else:
            self.fitness_saturation += 1

        ## Update the best over the iteration
        if vu_fitness.max() > self.citbest_rchi2["fitness"]:

            # print(f"Fitness updated from {self.citbest_rchi2['fitness']['fitness']} to {vu_fitness[unq_solut_ndx].max()}")

            # self.cbest_aic['aic'] = vu_aic[unq_solut_ndx].min()
            self.citbest_rchi2["chi2"] = vu_chi2[vufitmax]
            self.citbest_rchi2["aic"] = vu_aic[vufitmax]
            self.citbest_rchi2["fitness"] = vu_fitness[vufitmax]
            self.citbest_rchi2["ensemble"] = vu_parents[vufitmax]
            self.citbest_rchi2["gen_found"] = self.curr_gen
            # print(self.gen_paramfit.T[valid_solutions&unique_ensembles].iloc[vufitmax])
            self.citbest_rchi2["fit_pars"] = (
                self.gen_paramfit.T[valid_solutions & unique_ensembles]
                .iloc[vufitmax]
                .to_dict("list")
            )
            ## convert dict entries to floats not lists
            for key in list(self.cbest_rchi2["fit_pars"].keys()):
                self.citbest_rchi2["fit_pars"][key] = self.citbest_rchi2["fit_pars"][
                    key
                ][0]
            self.itbest_rchi2[self.curr_iter] = self.citbest_rchi2

        self.time_log["validation"] = time.time() - validate_time_start

    def choose_parents(self):
        """
        choose parents for the next generation
        """
        parents_time_start = time.time()
        if self.method == "prob":
            ## check if parents have duplicate indices in the ensemble
            unique_ensembles = np.apply_along_axis(unique_arr, 1, self.parents)
            weight_ndx = np.arange(0, self.n_ens, 1)
            x2weight = self.gen_fitness[self.curr_gen, :]

            if np.any(~unique_ensembles):
                # print("parent is non unique: removing them from the list ")
                nonunq_ensembles = np.where(~unique_ensembles)[0]
                weight_ndx = np.delete(weight_ndx, nonunq_ensembles)
                x2weight = np.delete(x2weight, nonunq_ensembles)

            x2weight_norm = x2weight / x2weight.sum()

            if self.elitism:
                max_fitness_parent = np.where(x2weight == x2weight.max())[0]
                self.elite_child = weight_ndx[
                    max_fitness_parent[0]
                ]  ## saving the index of the top fitness

            parent_indices = np.random.choice(weight_ndx, self.n_ens, p=x2weight_norm)

            parents_check = self.parents[parent_indices]
            # unq_func = lambda arr: (np.unique(arr).shape[0] == arr.shape[0])
            unique_ensembles = np.apply_along_axis(unique_arr, 1, parents_check)
            if np.any(~unique_ensembles):
                # print(parents_check)
                nonunq_ensembles = np.where(~unique_ensembles)[0]
                # print("parent is non unique")
                print(parents_check[nonunq_ensembles])

                # for nq_ndx in nonunq_ensembles:

            self.parent_pairs = self.parents[parent_indices.reshape(-1, 2)]

        self.time_log["parents"] = time.time() - parents_time_start

        # elif self.method == "rank":
        # sort_index =
        # rank_choose =
        # elif self.method == "rank-div":
        #    pass

        ## check to make sure the ensemble is unique, i.e there are no duplicates pairings

    def crossover(self):
        """
        crossover the parent indices for the next generation
        Always do the cross over i.e. [A,B],[C,D] ==> [A,C],[B,D]
        if ndx is == ens_size children == parents
        """
        crossover_time_start = time.time()

        copy_parent_pairs = self.parent_pairs
        for pnumb, ens_pair in enumerate(self.parent_pairs):
            co_ndx = 0
            for pi in range(self.ens_size):
                rcheck = np.random.rand()
                # print(pi,rcheck)
                if rcheck > self.p_crossover:
                    co_ndx = pi
                    break
                else:
                    continue
            ndx_check = pi == (self.ens_size - 1)
            co_check = co_ndx == 0
            if ndx_check and co_check:
                ## if each index fails the check to cross over, parents become children i.e. no crossover
                ## continue onto the next set of parents
                continue
            # print(ens_pair)
            parent1_copy = ens_pair[0]
            parent2_copy = ens_pair[1]
            # print(parent1_copy, parent2_copy)
            psel1 = parent1_copy[co_ndx + 1 :]
            psel2 = parent2_copy[: -(co_ndx + 1)]

            parent1_copy[co_ndx + 1 :] = psel2
            parent2_copy[: -(co_ndx + 1)] = psel1

            ### checks to see if the new parents are unique, i.e. each element in the array is singular
            p1_check = np.unique(parent1_copy).shape[0] != parent1_copy.shape[0]
            p2_check = np.unique(parent2_copy).shape[0] != parent2_copy.shape[0]

            ## if either p1_check or p2_check is true: continue on
            ## count the checks if a certain amount of checks fail for this generation,
            ## pool is either saturated or a optimal set of conformations has been found
            ## else crossover
            if p1_check or p2_check:
                print("crossed parents are not unique: continuing")
                continue
            else:
                ## crossover
                copy_parent_pairs[pnumb] = [parent1_copy, parent2_copy]

        ## after all crossovers are done, children are created.
        self.children = copy_parent_pairs.reshape(-1, self.ens_size)
        self.time_log["crossover"] = time.time() - crossover_time_start

    def mutation(self):
        """
        mutate the children after crossover
        """

        mutate_time_start = time.time()

        children_copy = self.children
        for nch, child in enumerate(self.children):

            for elem, chindx in enumerate(child):
                mut_check = np.random.rand()

                if mut_check <= self.p_mutate:

                    child_copy = child
                    child_copy[elem] = np.random.choice(self.mut_indices.shape[0], 1)[0]
                    child_check = (np.unique(child_copy).shape[0]) != child.shape[0]
                    if child_check:
                        print("child is not unique: continuing")
                        continue
                    else:
                        children_copy[nch] = child_copy
                        continue  ## only one mutation per child

        self.children = children_copy

        self.time_log["mutation"] = time.time() - mutate_time_start

    def check_genconvergence(self, citer):

        ## check 1: maximal generations
        if self.curr_gen == self.n_gen:
            print(
                "Reached the maximal number of generations: Moving On to the next Iteration"
            )
            self.gen_converged = True
            return None

        ## check 2:
        if not self.elitism:
            nconverge = 100
        else:
            ## give more chances for the elitist function to be exchanged
            nconverge = self.n_gen / 2.0

        # if self.fitness_saturation>nconverge:
        #    print(f"The fitness function has had the same value,{self.cbest_rchi2['fitness']}, over {nconverge} times.")
        #    print(f"Generation has most likely converged to a set ensemble. Moving onto iteration{citer+1}")
        #    self.gen_converged = True

        #    return None

        ## check 3: ##

    def check_iterconvergence(self):
        pass

    def wipe_generation(self):
        pass

    def evolve(self, dask_client):

        ##evaluate the
        self.curr_iter = 0
        for it in np.arange(0, self.n_iter, 1):

            self.curr_iter = it
            self.citbest_rchi2 = {
                "chi2": 0,
                "aic": 0,
                "fitness": 0,
                "ensemble": [0] * self.n_gen,
                "gen_found": 0,
                "fit_pars": {},
            }
            ## initialize the parents and mutation indices
            rcols = self.randomcol_indices()
            self.parents = self.indices[rcols]  ## parents, evovling

            ## How to check if the
            check_indices = [not (m in self.parents.flatten()) for m in self.indices]
            self.mut_indices = self.indices

            self.curr_gen = 0

            while not self.gen_converged:

                # for cg in np.arange(0,self.n_gen,1):
                ## update parents from the children of the previous generation
                ## children become parents in the end
                if self.curr_gen > 0:
                    self.parents = self.children

                print(f"Current Generation: {self.curr_gen}")
                ## evaluate parents
                self.evaluate(dask_client)
                self.validate_and_update()

                ## choose parents
                self.choose_parents()

                ## make children
                self.crossover()
                self.mutation()

                ## check convergence if not reached
                self.curr_gen += 1
                self.check_genconvergence(it)
                self.time_log["fitness_ave"] = self.individual_fitness_time.mean()

            ## clean up and save the best fits and ensembles for the generation, before moving on
            # self.validate_and_update()
            self.gen_converged = False

    def evaluate_bestfit(self):
        bestpars = gen_modelparams(self.ens_size, self.cbest_rchi2["fit_pars"])
        best_model = _residual_lmf(
            bestpars, self.data[self.cbest_rchi2["ensemble"][0]].values.T
        )
        return best_model

    def _write_bestmodel(self, foutname: Path = Path("./"), err=True):
        # print(self.data.index.values.shape, self.evaluate_bestfit().shape)
        bmdf = pd.DataFrame(
            columns=["q", "intensity"],
            data=np.vstack([self.data.index.values, self.evaluate_bestfit()]).T,
        )
        if err:
            bmdf["error"] = bmdf["intensity"] * 0.04

        bmdf.to_csv(
            f"{foutname}/best_model_EnsembleSize{self.ens_size}.csv",
            float_format="%E",
            sep=" ",
            index=None,
            columns=None,
        )

        return None

    def _write_parameterfile(
        self, pfile_name, structuredf, pfile_path: Path = Path(".")
    ):
        """
        Write out the best fits for the all the iterations of the genetic algorithm in order of chi^2
        Required parameters to save:
        Fit parameters to regenerate best models
        quality of fit: chi^2 , aic
        pdbname associated with the fits : provided by a separate file. pdbnames should be in the same order as the read in scattering data.
        probably similar to the GAJOE/NNLSJOE inputs
        Useful information:
        Generation Found
        Ensemble Size
        Structural Parameters:  provided by a separate file. Ordered the same as the scattering data. Should be of format PDBNAME ... parameters
        """
        parameter_cols = ["chi2", "aic", "fitness", "ensemble_size", "generation_found"]
        parameter_cols = parameter_cols + list(self.cbest_rchi2["fit_pars"].keys())
        ensemble_cols = [
            f"ensemble_index_{nn:d}" for nn in range(1, self.ens_size + 1, 1)
        ]
        pdb_cols = [f"PDBNAME_{nn}" for nn in range(1, self.ens_size + 1, 1)]
        if structuredf.shape[1] > 2:  ## should always be 2
            structure_cols = [
                f"{stcolname}_{nn}"
                for nn in range(1, self.ens_size + 1, 1)
                for stcolname in structuredf.columns[2:]
            ]
            parameter_cols = parameter_cols + ensemble_cols + pdb_cols + structure_cols
        else:
            parameter_cols = parameter_cols + ensemble_cols + pdb_cols

        # print(parameter_cols)
        gasans_summary_df = pd.DataFrame(
            index=range(0, self.n_iter, 1), columns=parameter_cols
        )

        ## Order the self.itbest_rchi2
        for ni in range(self.n_iter):
            gasans_summary_df.loc[ni, "chi2"] = self.itbest_rchi2[ni]["chi2"]
            gasans_summary_df.loc[ni, "aic"] = self.itbest_rchi2[ni]["aic"]
            gasans_summary_df.loc[ni, "fitness"] = self.itbest_rchi2[ni]["fitness"]
            gasans_summary_df.loc[ni, "ensemble_size"] = self.ens_size
            gasans_summary_df.loc[ni, "generation_found"] = self.itbest_rchi2[ni][
                "gen_found"
            ]
            gasans_summary_df.loc[
                ni, list(self.itbest_rchi2[ni]["fit_pars"].keys())
            ] = list(self.itbest_rchi2[ni]["fit_pars"].values())
            gasans_summary_df.loc[ni, ensemble_cols] = self.itbest_rchi2[ni][
                "ensemble"
            ][0]
            gasans_summary_df.loc[ni, pdb_cols] = structuredf.iloc[
                self.itbest_rchi2[ni]["ensemble"][0], 0
            ].values
            if structuredf.shape[1] > 2:
                gasans_summary_df.loc[ni, structure_cols] = structuredf.iloc[
                    self.itbest_rchi2[ni]["ensemble"][0], 2:
                ].values.flatten()

        gasans_summary_df.sort_values("chi2").to_csv(
            "{}/{}".format(pfile_path, pfile_name.format(self.ens_size))
        )

        return None


def _read_SANSFiles(sans_dir: Path, sans_struct, qmin=0.0, qmax=0.5, nq=501):
    """
    Read in the sans files
    This may be part of the GA object soon? Why have
    """

    scatteringdf = pd.DataFrame(
        index=np.linspace(qmin, qmax, nq), columns=sans_struct.index
    )

    for nn, file in sans_struct.iterrows():
        # print(file['SCATTERINGFILE'])
        sansdf = pd.read_csv(
            f"{sans_dir}/{file['SCATTERINGFILE']}",
            delim_whitespace=True,
            usecols=[0, 1],
            skiprows=6,
            header=None,
            names=["q", "I"],
        )

        scatteringdf.loc[:, nn] = sansdf["I"].values

    return scatteringdf


def _read_experiment_data(
    dataloc,
):

    expdata_df = pd.read_csv(dataloc, delim_whitespace=True, comment="#", header=None)
    if expdata_df.shape[1] == 3:
        expdata_df.columns = ["Q", "I(Q)", "Error"]
    elif expdata_df.shape[1] == 4:
        expdata_df.columns = ["Q", "I(Q)", "Error", "dQ"]
    else:
        print(
            f"Experimental Data not in 3 or 4 column format to read. The shape of the read data is {expdata_df.shape}"
        )
        raise SystemExit("")
    return expdata_df


if __name__ == "__main__":

    ## Read Config File
    config_file1 = Path("./config_test.json")
    if config_file1.exists():
        print(f"config file, {config_file1}, exists. Reading config file")
        config_filelist, config_ga_input = _read_json_input(config_file1)
    else:
        print(f"config file, {config_file1}, does not exist")

    path2sans = Path(config_filelist["scatter_dir"])

    ## Need to make this arbirary read to also remove comments
    experiment_datadf = _read_experiment_data(config_filelist["experiment"])
    qmin = 0.08
    qmax = 0.35

    ScatStructureDF = pd.read_csv(config_filelist["structurefile"])
    print(ScatStructureDF.head())

    ## Changed to local path or like MultiFOXS a txt file of paths to scattering intensities
    ##
    ensemble_scatteringdf = _read_SANSFiles(
        config_filelist["scatter_dir"], ScatStructureDF
    )

    exp_qmax_ndx = np.where(experiment_datadf["Q"] < qmax)[0][-1]
    for enssize_config in config_ga_input:
        print(
            f"Running Genetic Algorithm for Ensemble Size:{enssize_config['ensemble_size']}"
        )
        GARes = GAEnsembleOpt(
            ensemble_scatteringdf,
            experiment_datadf.iloc[1:exp_qmax_ndx],
            **enssize_config,
            #                        #ens_size=2, n_gen=5, n_iter=5, ens_split=1.0,
            #                        #mut_prob=0.1,elitism=False, invabsx2=True, parallel=True,
        )

        with distributed.LocalCluster(
            n_workers=int(0.4 * os.cpu_count()),
            processes=True,
            threads_per_worker=1,
        ) as cluster, distributed.Client(cluster) as client:
            GARes.evolve(dask_client=client)

        # print(GA2_HDX.time_log)
        # print(GA2_HDX.cbest_rchi2)

        GARes._write_bestmodel()
        GARes._write_parameterfile("gasans_summary_EnsSize{}.csv", ScatStructureDF)
