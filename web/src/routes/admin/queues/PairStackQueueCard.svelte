<script lang="ts">
  import {
    DEFAULT_PAIR_STACK_CONCURRENCY,
    MAX_PAIR_STACK_CONCURRENCY,
    MIN_PAIR_STACK_CONCURRENCY,
    pairStackJobManager,
  } from '$lib/managers/pair-stack-job-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { PairStackJobStatus, type PairStackJobTaskDto } from '@immich/sdk';
  import { Badge, Icon, Input, ProgressBar } from '@immich/ui';
  import { mdiAlertCircle, mdiImageMultipleOutline, mdiPlay } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import QueueCardButton from './QueueCardButton.svelte';

  type StatusColor = 'success' | 'info' | 'warning' | 'danger';

  let concurrencyInput = $state(String(DEFAULT_PAIR_STACK_CONCURRENCY));
  let submitting = $state(false);

  const task = $derived(pairStackJobManager.task);
  const parsedConcurrency = $derived(Number(concurrencyInput));
  const concurrencyValid = $derived(
    Number.isSafeInteger(parsedConcurrency) &&
      parsedConcurrency >= MIN_PAIR_STACK_CONCURRENCY &&
      parsedConcurrency <= MAX_PAIR_STACK_CONCURRENCY,
  );
  const isRunning = $derived(task?.status === PairStackJobStatus.Running);
  const canResume = $derived(
    task?.status === PairStackJobStatus.Interrupted ||
      (task?.status === PairStackJobStatus.Failed && task.error?.recoverable === true),
  );
  const needsManualReview = $derived(task?.status === PairStackJobStatus.Failed && task.error?.recoverable !== true);
  const actionDisabled = $derived(submitting || isRunning || needsManualReview || (!canResume && !concurrencyValid));
  const inputDisabled = $derived(submitting || isRunning || canResume || needsManualReview);

  const getStatusColor = (status: PairStackJobStatus): StatusColor => {
    switch (status) {
      case PairStackJobStatus.Running: {
        return 'success';
      }
      case PairStackJobStatus.Succeeded: {
        return 'info';
      }
      case PairStackJobStatus.Interrupted: {
        return 'warning';
      }
      case PairStackJobStatus.Failed: {
        return 'danger';
      }
      default: {
        return 'info';
      }
    }
  };

  const getProgressText = (current: number, total: number) =>
    $t('admin.pair_stack_progress', {
      values: {
        current: current.toLocaleString($locale),
        total: total.toLocaleString($locale),
      },
    });

  const statusDescription = (currentTask: PairStackJobTaskDto) => {
    if (currentTask.status === PairStackJobStatus.Succeeded) {
      return $t('admin.pair_stack_succeeded');
    }
    if (currentTask.status === PairStackJobStatus.Interrupted) {
      return $t('admin.pair_stack_interrupted');
    }
    if (currentTask.status === PairStackJobStatus.Failed && currentTask.error) {
      return $t('admin.pair_stack_failed', { values: { message: currentTask.error.message } });
    }
    return undefined;
  };

  const submit = async () => {
    if (actionDisabled) {
      return;
    }

    submitting = true;
    try {
      if (canResume && task) {
        await pairStackJobManager.resume(task);
      } else {
        await pairStackJobManager.stack(parsedConcurrency);
      }
    } catch (error) {
      handleError(error, $t('admin.pair_stack_start_failed'));
    } finally {
      submitting = false;
    }
  };
</script>

<div class="sm:rounded-9 flex flex-col overflow-hidden rounded-2xl bg-gray-100 sm:flex-row dark:bg-immich-dark-gray">
  <div class="flex w-full flex-col">
    {#if task}
      <div class="flex flex-wrap gap-2 p-2 text-center text-sm">
        <Badge color={getStatusColor(task.status)}>{task.status}</Badge>
        {#if pairStackJobManager.runnerAvailable === false}
          <Badge color="warning">{$t('admin.pair_stack_runner_unavailable')}</Badge>
        {/if}
      </div>
    {:else if pairStackJobManager.runnerAvailable === false}
      <div class="p-2 text-center text-sm">
        <Badge color="warning">{$t('admin.pair_stack_runner_unavailable')}</Badge>
      </div>
    {/if}

    <div class="flex flex-col gap-2 p-5 sm:p-7 md:p-9">
      <div class="flex items-center gap-2 text-xl font-semibold text-primary">
        <Icon icon={mdiImageMultipleOutline} size="1.25em" class="hidden shrink-0 sm:block" />
        <span>{$t('admin.pair_stack_job')}</span>
      </div>

      <div class="text-sm whitespace-pre-line dark:text-white">{$t('admin.pair_stack_job_description')}</div>

      <div class="mt-2 flex w-full max-w-xl flex-col gap-4">
        <div class="flex items-center justify-between gap-4">
          <label for="pair-stack-concurrency" class="text-sm font-medium">{$t('admin.pair_stack_concurrency')}</label>
          <Input
            id="pair-stack-concurrency"
            class="w-24"
            type="number"
            bind:value={concurrencyInput}
            min={MIN_PAIR_STACK_CONCURRENCY}
            max={MAX_PAIR_STACK_CONCURRENCY}
            step="1"
            disabled={inputDisabled}
            aria-describedby="pair-stack-concurrency-help"
          />
        </div>
        <div id="pair-stack-concurrency-help" class="text-xs text-gray-500 dark:text-gray-300">
          {$t('admin.pair_stack_concurrency_description', {
            values: { minimum: MIN_PAIR_STACK_CONCURRENCY, maximum: MAX_PAIR_STACK_CONCURRENCY },
          })}
        </div>

        {#if task}
          <div class="flex flex-col gap-2 text-sm dark:text-white">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span>{$t('admin.pair_stack_phase', { values: { phase: task.phase } })}</span>
              {#if task.progress.determinate && task.progress.percent !== null}
                <span>{getProgressText(task.progress.current, task.progress.total)}</span>
              {:else}
                <span>{$t('admin.pair_stack_progress_pending')}</span>
              {/if}
            </div>
            {#if task.progress.determinate && task.progress.percent !== null}
              <ProgressBar progress={task.progress.percent} />
            {/if}
            <div class="flex flex-wrap gap-2">
              <Badge>{$t('admin.pair_stack_committed', { values: { count: task.counts.committed } })}</Badge>
              <Badge>{$t('admin.pair_stack_posts', { values: { count: task.progress.posts } })}</Badge>
            </div>
            {#if statusDescription(task)}
              <div class="text-sm">{statusDescription(task)}</div>
            {/if}
            {#if needsManualReview}
              <div class="text-sm text-red-700 dark:text-red-300">{$t('admin.pair_stack_manual_review')}</div>
            {/if}
            {#if task.finishedAt}
              <time class="text-xs text-gray-500 dark:text-gray-300" datetime={task.finishedAt}>
                {$t('admin.pair_stack_finished', {
                  values: { time: new Date(task.finishedAt).toLocaleString($locale) },
                })}
              </time>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="flex w-full flex-row overflow-hidden sm:w-32 sm:flex-col">
    <QueueCardButton color={canResume ? 'gray' : 'dark-gray'} disabled={actionDisabled} onClick={submit}>
      {#if needsManualReview}
        <Icon icon={mdiAlertCircle} size="36" />
      {:else if canResume}
        <Icon icon={mdiPlay} size="36" />
      {:else}
        <Icon icon={mdiImageMultipleOutline} size="36" />
      {/if}
      <span>{canResume ? $t('resume') : $t('stack')}</span>
    </QueueCardButton>
  </div>
</div>
