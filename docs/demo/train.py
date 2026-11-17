import time
for epoch, loss in [(1, 0.912), (2, 0.537)]:
    time.sleep(0.9)
    print(f"epoch {epoch}/3  loss {loss}", flush=True)
time.sleep(600)  # stuck: no output, no CPU
