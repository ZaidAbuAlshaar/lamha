import os

# Tests never call the cloud fallback (no network, no spend); test_cloud.py stubs it explicitly.
os.environ["NAZRA_CLOUD_FALLBACK"] = "0"
