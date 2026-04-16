---
name: fine-tuning
description: LLM fine-tuning authority — LoRA, QLoRA, and full fine-tuning workflows with PEFT, Axolotl, and Unsloth; supervised fine-tuning (SFT), DPO, and RLHF alignment; dataset curation and formatting; GPTQ/AWQ quantization; vLLM serving; and evaluation with lm-evaluation-harness
orb_class: moon
keywords: ["lora", "qlora", "peft", "sft", "dpo", "rlhf", "axolotl", "unsloth", "huggingface", "trainer", "trl", "gptq", "awq", "bitsandbytes", "vllm", "lm-eval", "fine-tune", "alignment", "dataset-curation", "flash-attention"]
---

# Fine-Tuning

Production authority on adapting large language models: parameter-efficient fine-tuning with LoRA/QLoRA, full supervised fine-tuning, preference alignment via DPO and RLHF, quantization for deployment, and systematic evaluation. Use this skill when training or adapting any LLM beyond prompting, including domain adaptation, instruction following, and RLHF pipelines.

## Core Concepts

### LoRA vs QLoRA vs Full Fine-Tune

LoRA (Low-Rank Adaptation) injects trainable rank-decomposition matrices into attention layers, leaving base weights frozen. A rank-16 LoRA on a 7B model trains ~8M parameters instead of 7B — fits in ~24 GB VRAM. QLoRA adds 4-bit NF4 quantization of the frozen base weights (via bitsandbytes), enabling 7B fine-tuning on a single 16 GB GPU. Full fine-tuning is reserved for fundamental domain shifts where LoRA rank capacity is genuinely insufficient, or when you have 8+ A100s.

### PEFT + Hugging Face Trainer (LoRA SFT)

```python
from transformers import AutoTokenizer, AutoModelForCausalLM, TrainingArguments
from peft import LoraConfig, get_peft_model, TaskType
from trl import SFTTrainer
from datasets import load_dataset
import torch

MODEL_ID = "meta-llama/Meta-Llama-3-8B-Instruct"

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
tokenizer.pad_token = tokenizer.eos_token
tokenizer.padding_side = "right"  # critical for causal LM training

model = AutoModelForCausalLM.from_pretrained(
    MODEL_ID,
    torch_dtype=torch.bfloat16,   # bf16 > fp16 for training stability
    device_map="auto",
    attn_implementation="flash_attention_2",  # 3-5x memory savings
)

lora_config = LoraConfig(
    r=16,                    # rank — higher = more capacity, more VRAM
    lora_alpha=32,           # scaling factor; effective lr scales as alpha/r
    target_modules=[         # target all attention projections
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",  # include MLP for better perf
    ],
    lora_dropout=0.05,
    bias="none",
    task_type=TaskType.CAUSAL_LM,
)
model = get_peft_model(model, lora_config)
model.print_trainable_parameters()
# trainable params: 41,943,040 || all params: 8,072,204,288 || trainable%: 0.52

dataset = load_dataset("json", data_files={"train": "train.jsonl", "test": "test.jsonl"})

args = TrainingArguments(
    output_dir="./llama3-8b-lora",
    num_train_epochs=3,
    per_device_train_batch_size=4,
    gradient_accumulation_steps=4,   # effective batch = 16
    learning_rate=2e-4,
    lr_scheduler_type="cosine",
    warmup_ratio=0.03,
    weight_decay=0.01,
    bf16=True,
    logging_steps=10,
    save_strategy="epoch",
    eval_strategy="epoch",
    load_best_model_at_end=True,
    report_to="wandb",
)

trainer = SFTTrainer(
    model=model,
    args=args,
    train_dataset=dataset["train"],
    eval_dataset=dataset["test"],
    dataset_text_field="text",      # or use formatting_func for chat templates
    max_seq_length=4096,
    packing=True,                   # pack short sequences to fill context window
)
trainer.train()
model.save_pretrained("./final-lora-adapter")
```

### QLoRA (4-bit base model)

```python
from transformers import BitsAndBytesConfig

bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",        # NormalFloat4 — optimal for normal-distributed weights
    bnb_4bit_compute_dtype=torch.bfloat16,
    bnb_4bit_use_double_quant=True,   # nested quantization saves ~0.4 bits/param
)
model = AutoModelForCausalLM.from_pretrained(MODEL_ID, quantization_config=bnb_config)
# Run prepare_model_for_kbit_training before applying LoRA
from peft import prepare_model_for_kbit_training
model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
```

### Dataset Curation and Formatting

Quality beats quantity. 10k high-quality examples outperform 500k scraped pairs. Format datasets using the model's chat template — do not hand-roll delimiters.

```python
def format_chat(example):
    messages = [
        {"role": "system", "content": example["system"]},
        {"role": "user",   "content": example["instruction"]},
        {"role": "assistant", "content": example["output"]},
    ]
    return {"text": tokenizer.apply_chat_template(messages, tokenize=False)}

dataset = dataset.map(format_chat)
```

Deduplication is mandatory: use MinHash LSH (datasketch) or exact SHA256 dedup. Filter on length (drop < 50 tokens, > 4096 tokens), perplexity score (drop incoherent samples), and reward model score for preference data.

### Axolotl Configuration

Axolotl wraps all of the above in a single YAML config:

```yaml
base_model: meta-llama/Meta-Llama-3-8B-Instruct
model_type: LlamaForCausalLM
tokenizer_type: AutoTokenizer

load_in_4bit: true
adapter: lora
lora_r: 16
lora_alpha: 32
lora_target_modules: [q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj]

datasets:
  - path: data/train.jsonl
    type: chat_template
val_set_size: 0.02
dataset_prepared_path: ./prepared

sequence_len: 4096
sample_packing: true
bf16: true
flash_attention: true

num_epochs: 3
micro_batch_size: 4
gradient_accumulation_steps: 4
learning_rate: 0.0002
lr_scheduler: cosine
warmup_steps: 100
weight_decay: 0.01
output_dir: ./output
wandb_project: my-finetune
```

Run: `accelerate launch -m axolotl.cli.train config.yaml`

### DPO (Direct Preference Optimization)

DPO skips the reward model training step of RLHF by directly optimizing on preference pairs. Requires a dataset of `(prompt, chosen, rejected)` triples.

```python
from trl import DPOTrainer, DPOConfig

dpo_config = DPOConfig(
    beta=0.1,              # KL penalty strength; 0.1-0.5 typical
    loss_type="sigmoid",   # "sigmoid" (DPO) or "ipo" (IPO variant)
    learning_rate=5e-7,    # DPO uses much lower LR than SFT
    num_train_epochs=1,    # easy to overfit on preference data
    per_device_train_batch_size=2,
    gradient_accumulation_steps=8,
    bf16=True,
)

dpo_trainer = DPOTrainer(
    model=model,
    ref_model=ref_model,  # frozen copy of the SFT model (or None if using implicit ref)
    args=dpo_config,
    train_dataset=pref_dataset,  # must have columns: prompt, chosen, rejected
    tokenizer=tokenizer,
)
dpo_trainer.train()
```

### Quantization for Deployment (GPTQ / AWQ)

```python
# AWQ — faster inference than GPTQ, better perplexity at 4-bit
from awq import AutoAWQForCausalLM

model = AutoAWQForCausalLM.from_pretrained(MODEL_ID)
model.quantize(tokenizer, quant_config={"w_bit": 4, "q_group_size": 128, "zero_point": True})
model.save_quantized("./llama3-8b-awq")
```

### vLLM Serving

```python
from vllm import LLM, SamplingParams

llm = LLM(
    model="./llama3-8b-awq",
    quantization="awq",
    tensor_parallel_size=2,      # split across 2 GPUs
    gpu_memory_utilization=0.90,
    max_model_len=8192,
)
outputs = llm.generate(["Explain LoRA in one sentence"], SamplingParams(temperature=0.7, max_tokens=256))
```

vLLM's PagedAttention eliminates KV cache fragmentation. Throughput is typically 10-20x higher than naive Hugging Face generate for batched workloads.

### Evaluation (lm-evaluation-harness)

```bash
lm_eval --model hf \
  --model_args pretrained=./output,peft=./final-lora-adapter \
  --tasks mmlu,hellaswag,arc_challenge,truthfulqa_mc2 \
  --num_fewshot 5 \
  --batch_size auto \
  --output_path results.json
```

Domain evals matter more than benchmarks. Always build a held-out task-specific eval set and measure it alongside public benchmarks. Watch for benchmark contamination in training data (deduplicate against MMLU/HellaSwag questions).

### Common Pitfalls

- **Catastrophic forgetting**: fine-tuning on narrow data degrades general capability. Mitigate with LoRA (frozen base) or replay mixing (5-10% general-purpose data in every batch).
- **Chat template mismatch**: training with wrong delimiters causes the model to generate stop tokens randomly in production. Always call `apply_chat_template`.
- **Learning rate too high for DPO**: DPO at SFT learning rates collapses the policy. Use 5e-7 to 1e-6.
- **Packing with unmasked padding**: when using sequence packing, ensure cross-document attention is masked (set `dataset_text_field` with SFTTrainer's built-in masking, or use `DataCollatorForCompletionOnlyLM`).
