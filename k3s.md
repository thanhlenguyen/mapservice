# Set up and deploy mapservice on K3s
## Step 1: Update your WSL2 distro
```
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget vim git
sudo apt install -y conntrack socat iproute2
```
## Step 2: Install k3s (lightweight Kubernetes)
```
curl -sfL https://get.k3s.io | sh -
```
Check k3s status
`sudo k3s kubectl get nodes`

You should see one node in Ready status.


Optional alias to simplify kubectl:
```
sudo chown $USER:$USER /etc/rancher/k3s/k3s.yaml
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' >> ~/.bashrc
```
Then you can just use:
`kubectl get nodes`

### Step 3: Install kompose
```
# Download kompose
curl -L https://github.com/kubernetes/kompose/releases/download/v1.37.0/kompose-linux-amd64 -o kompose

# Make it executable
chmod +x kompose

# Move to a directory in PATH
sudo mv kompose /usr/local/bin/

# Verify installation
kompose version
```