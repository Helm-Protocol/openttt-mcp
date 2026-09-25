CLANG ?= clang
CFLAGS ?= -O2 -g -target bpf -I/usr/include/x86_64-linux-gnu

all: tttps_xdp.o

tttps_xdp.o: tttps_xdp.c
	$(CLANG) $(CFLAGS) -c $< -o $@

clean:
	rm -f tttps_xdp.o
